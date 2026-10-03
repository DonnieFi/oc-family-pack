import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EVENT_ID_MAX, LINK_MAX, LOCATION_MAX, MESSAGE_MAX, TITLE_MAX } from "./contract.ts";
import type { CalendarConfig, CalendarStateOf, Config, FamilyEvent } from "./types.ts";
import { addDays, parseDate, startOfLocalDay, type Week } from "./week.ts";

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT_MS = 20_000;

export const GOG_SETUP_HINT = "Run `openclaw family gog` and follow the command it prints.";
/** gog 0.39's wording for a missing account, OAuth client, or usable token; anything else is a per-calendar failure. */
const GOG_AUTH_FAILURE =
  /missing --account|OAuth client credentials missing|No OAuth client credentials stored|\(401 authError\)|invalid_grant|no TTY available for keyring/;
const UNREADABLE = "unreadable output";
/**
 * `--max` is Google Calendar `maxResults`: events per page, not a total.
 * `--all-pages` walks pages in gog's `collectAllPages`, which allows 10,000 pages
 * and then fails with "pagination exceeded max pages" instead of returning a short list.
 * A leftover nextPageToken means this response stopped before the last page.
 */
const GOG_PAGE_SIZE = "250";
const GOG_PAGE_CAP = /pagination exceeded max pages/;

/** Resolves with gog's stdout; rejects like `execFile` on a spawn failure, non-zero exit, or timeout. */
export type RunGog = (file: string, args: string[]) => Promise<{ stdout: string }>;

export function execGog(timeoutMs = GOG_TIMEOUT_MS): RunGog {
  return (file, args) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

/** Google fields a calendar write needs; they stay on the Gateway and never reach the page. */
export type GoogleEventFields = {
  eventId: string;
  updated?: string;
  etag?: string;
  recurringEventId?: string;
  /** The instance's slot in its series, in the same form as `start`; present only on recurring instances. */
  originalStart?: string;
};

export type GogEvent = FamilyEvent & { google: GoogleEventFields };

type GoogleTime = { dateTime?: unknown; date?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cuts a Google string to its wire maxLength so one over-long field cannot fail the whole week. */
export function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

const HTML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** School and ICS feeds store `&amp;` and `&#39;` in titles. One decode, the same way a browser does. */
function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (entity, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return entity;
      }
      return String.fromCodePoint(code);
    }
    return HTML_NAMED[body.toLowerCase()] ?? entity;
  });
}

function readTime(value: unknown): { at: string; allDay: boolean } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { dateTime, date } = value as GoogleTime;
  if (typeof dateTime === "string" && Number.isFinite(Date.parse(dateTime))) {
    return { at: new Date(dateTime).toISOString(), allDay: false };
  }
  // Round-trip: 2026-13-45 matches the shape but is not a day, and addDays would throw on it.
  if (typeof date === "string" && parseDate(date) !== undefined) {
    return { at: date, allDay: true };
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Base64 (standard or url-safe) of a Google `eid`. Invalid padding decodes to nothing. */
function decodeEid(eid: string): string | undefined {
  const normalized = eid.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  return decoded && !decoded.includes("\u0000") ? decoded : undefined;
}

/**
 * A link the page may open. Google's `eid` is the event id plus the calendar id,
 * and that calendar id is often an email, so any eid that decodes to an address
 * is dropped. The wire keeps calendar keys (`c0`) instead.
 */
function googleEventLink(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (!text || text.length > LINK_MAX) return undefined;
  const url = URL.parse(text);
  if (!url || url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (host !== "calendar.google.com" && host !== "www.google.com") return undefined;
  for (const part of url.searchParams.values()) {
    if (part.includes("@")) return undefined;
  }
  const eid = url.searchParams.get("eid");
  if (eid) {
    const decoded = decodeEid(eid);
    if (decoded === undefined || decoded.includes("@")) return undefined;
  }
  return text;
}

function instant(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function googleFields(eventId: string, item: Record<string, unknown>): GoogleEventFields {
  const fields: GoogleEventFields = { eventId };
  const updated = instant(item.updated);
  const etag = nonEmpty(item.etag);
  const recurringEventId = nonEmpty(item.recurringEventId);
  const originalStart = readTime(item.originalStartTime)?.at;
  if (updated) fields.updated = updated;
  if (etag) fields.etag = etag;
  if (recurringEventId) fields.recurringEventId = recurringEventId;
  if (originalStart) fields.originalStart = originalStart;
  return fields;
}

/** gog prints Google Calendar event resources, either bare (`--results-only`) or under `events`; anything else is unreadable. */
export function parseGogEvents(raw: unknown, calendar: CalendarConfig): GogEvent[] | undefined {
  const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.events) ? raw.events : undefined;
  if (!items) {
    return undefined;
  }
  const events: GogEvent[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || item.status === "cancelled" || typeof item.id !== "string") {
      continue;
    }
    const id = clip(`${calendar.key}/${item.id}`, EVENT_ID_MAX);
    if (seen.has(id)) {
      continue;
    }
    const start = readTime(item.start);
    const end = readTime(item.end) ?? start;
    if (!start || !end || start.allDay !== end.allDay) {
      continue;
    }
    let endAt = end.at;
    if (start.allDay && end.at === start.at) {
      try {
        endAt = addDays(start.at, 1);
      } catch (error) {
        if (error instanceof RangeError) {
          continue;
        }
        throw error;
      }
    }
    seen.add(id);
    const event: GogEvent = {
      id,
      title: clip(unescapeHtml(nonEmpty(item.summary) ?? "(No title)"), TITLE_MAX),
      start: start.at,
      end: endAt,
      allDay: start.allDay,
      calendarKey: calendar.key,
      google: googleFields(item.id, item),
    };
    const location = nonEmpty(item.location);
    if (location) {
      event.location = clip(unescapeHtml(location), LOCATION_MAX);
    }
    const htmlLink = googleEventLink(item.htmlLink);
    if (htmlLink) {
      event.htmlLink = htmlLink;
    }
    events.push(event);
  }
  return events;
}

type CalendarRead =
  | { status: "ok"; events: GogEvent[]; truncated: boolean }
  | { status: "unconfigured" }
  | { status: "auth" }
  | { status: "error"; message: string };

function calendarProblem(label: string, reason: string): string {
  return `Could not read the "${label}" calendar: ${reason}`.slice(0, MESSAGE_MAX);
}

function pageCapWarning(label: string): string {
  return `The "${label}" calendar hit gog's page cap, so some events are missing.`;
}

/** Classifies a failed gog run. stderr is read only to choose a fixed message; it is never copied. */
function classifyFailure(error: unknown, label: string): CalendarRead {
  const failure = isRecord(error) ? error : {};
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  if (failure.code === "ENOENT") {
    return { status: "unconfigured" };
  }
  if (failure.killed === true) {
    return { status: "error", message: calendarProblem(label, "timed out") };
  }
  if (GOG_PAGE_CAP.test(stderr)) {
    return { status: "error", message: pageCapWarning(label) };
  }
  if (typeof failure.code === "number" && GOG_AUTH_FAILURE.test(stderr)) {
    return { status: "auth" };
  }
  const code =
    typeof failure.code === "number" || typeof failure.code === "string"
      ? String(failure.code)
      : typeof failure.signal === "string"
        ? failure.signal
        : "1";
  return { status: "error", message: calendarProblem(label, `gog error code ${code}`) };
}

function hasAnotherPage(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.nextPageToken === "string" && raw.nextPageToken.trim() !== "";
}

async function readCalendar(config: Config, calendar: CalendarConfig, { range }: Pick<Week, "range">, runGog: RunGog): Promise<CalendarRead> {
  const from = new Date(startOfLocalDay(range.start, range.timezone)).toISOString();
  const to = new Date(startOfLocalDay(addDays(range.end, 1), range.timezone)).toISOString();
  let stdout: string;
  try {
    ({ stdout } = await runGog(config.gogPath, [
      "calendar",
      "events",
      "--from",
      from,
      "--to",
      to,
      "--all-pages",
      "--max",
      GOG_PAGE_SIZE,
      "--json",
      "--no-input",
      "--",
      calendar.id,
    ]));
  } catch (error) {
    return classifyFailure(error, calendar.label);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { status: "error", message: calendarProblem(calendar.label, UNREADABLE) };
  }
  const events = parseGogEvents(raw, calendar);
  if (!events) {
    return { status: "error", message: calendarProblem(calendar.label, UNREADABLE) };
  }
  return { status: "ok", events, truncated: hasAnotherPage(raw) };
}

/**
 * One calendar's failure becomes a warning beside the rest. The source is unconfigured only when gog is missing or every calendar fails auth.
 * Events keep their Google fields for the classifier; the week payload strips them at its boundary.
 */
export async function readGogCalendars(config: Config, span: Pick<Week, "range">, runGog: RunGog = execGog()): Promise<CalendarStateOf<GogEvent>> {
  if (config.calendars.length === 0) {
    return { status: "unconfigured", hint: `Add calendars to the plugin config. ${GOG_SETUP_HINT}` };
  }
  const reads = await Promise.all(config.calendars.map((calendar) => readCalendar(config, calendar, span, runGog)));
  if (reads.some((read) => read.status === "unconfigured")) {
    return { status: "unconfigured", hint: GOG_SETUP_HINT };
  }
  if (reads.every((read) => read.status === "auth")) {
    return { status: "unconfigured", hint: GOG_SETUP_HINT };
  }
  const warnings = reads.flatMap((read, index) => {
    const label = config.calendars[index]?.label ?? "Calendar";
    if (read.status === "auth") {
      return [`Reconnect gog for ${label}`];
    }
    if (read.status === "error") {
      return [read.message];
    }
    return read.status === "ok" && read.truncated ? [pageCapWarning(label)] : [];
  });
  const failed = reads.filter((read) => read.status === "error" || read.status === "auth").length;
  if (failed === reads.length) {
    return { status: "error", message: clip(warnings.join(" "), MESSAGE_MAX) };
  }
  return {
    status: "ok",
    data: reads.flatMap((read) => (read.status === "ok" ? read.events : [])),
    warnings,
  };
}
