import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EVENT_ID_MAX, LINK_MAX, LOCATION_MAX, MESSAGE_MAX, TITLE_MAX } from "./contract.ts";
import type { CalendarConfig, CalendarState, Config, FamilyEvent } from "./types.ts";
import { addDays, startOfLocalDay, type Week } from "./week.ts";

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT_MS = 20_000;

export const GOG_SETUP_HINT =
  "Install gog, run `gog auth add you@example.com --services calendar`, then list calendar IDs with `gog calendar calendars`.";
/** gog 0.39's wording for a missing account, OAuth client, or usable token; anything else is a per-calendar failure. */
const GOG_AUTH_FAILURE =
  /missing --account|OAuth client credentials missing|No OAuth client credentials stored|\(401 authError\)|invalid_grant|no TTY available for keyring/;
const UNREADABLE = "gog returned unreadable output";

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

function readTime(value: unknown): { at: string; allDay: boolean } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { dateTime, date } = value as GoogleTime;
  if (typeof dateTime === "string" && Number.isFinite(Date.parse(dateTime))) {
    return { at: new Date(dateTime).toISOString(), allDay: false };
  }
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { at: date, allDay: true };
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The page renders this as a link, so only https URLs survive, and a cut URL would be broken, so long ones are dropped. */
function httpsUrl(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text && text.length <= LINK_MAX && URL.parse(text)?.protocol === "https:" ? text : undefined;
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
  for (const item of items) {
    if (!isRecord(item) || item.status === "cancelled" || typeof item.id !== "string") {
      continue;
    }
    const start = readTime(item.start);
    const end = readTime(item.end) ?? start;
    if (!start || !end || start.allDay !== end.allDay) {
      continue;
    }
    const event: GogEvent = {
      id: clip(`${calendar.key}/${item.id}`, EVENT_ID_MAX),
      title: clip(nonEmpty(item.summary) ?? "(No title)", TITLE_MAX),
      start: start.at,
      end: start.allDay && end.at === start.at ? addDays(start.at, 1) : end.at,
      allDay: start.allDay,
      calendarKey: calendar.key,
      google: googleFields(item.id, item),
    };
    const location = nonEmpty(item.location);
    if (location) {
      event.location = clip(location, LOCATION_MAX);
    }
    const htmlLink = httpsUrl(item.htmlLink);
    if (htmlLink) {
      event.htmlLink = htmlLink;
    }
    events.push(event);
  }
  return events;
}

function toWire({ google: _google, ...event }: GogEvent): FamilyEvent {
  return event;
}

type CalendarRead = { status: "ok"; events: GogEvent[] } | { status: "unconfigured" } | { status: "error"; message: string };

async function readCalendar(config: Config, calendar: CalendarConfig, week: Week, runGog: RunGog): Promise<CalendarRead> {
  const failed = (reason: string): CalendarRead => ({
    status: "error",
    message: `Could not read the "${calendar.label}" calendar: ${reason.replaceAll(calendar.id, "<id>").slice(0, 200)}`,
  });
  const from = new Date(startOfLocalDay(week.range.start, week.range.timezone)).toISOString();
  const to = new Date(startOfLocalDay(addDays(week.range.end, 1), week.range.timezone)).toISOString();
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
      "250",
      "--json",
      "--no-input",
      "--",
      calendar.id,
    ]));
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    if (failure.code === "ENOENT") {
      return { status: "unconfigured" };
    }
    if (typeof failure.code === "string") {
      return failed(`gog could not run (${failure.code})`);
    }
    if (typeof failure.code !== "number") {
      return failed(failure.killed === true ? "gog timed out" : "gog was stopped");
    }
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    if (GOG_AUTH_FAILURE.test(stderr)) {
      return { status: "unconfigured" };
    }
    return failed(stderr.split("\n").at(-1) || `gog exited with code ${failure.code}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return failed(UNREADABLE);
  }
  const events = parseGogEvents(raw, calendar);
  return events ? { status: "ok", events } : failed(UNREADABLE);
}

/** One failing calendar becomes a warning beside the rest; the source fails only when gog is unusable or every calendar fails. */
export async function readGogCalendars(config: Config, week: Week, runGog: RunGog = execGog()): Promise<CalendarState> {
  if (config.calendars.length === 0) {
    return { status: "unconfigured", hint: `Add calendars to the plugin config. ${GOG_SETUP_HINT}` };
  }
  const reads = await Promise.all(config.calendars.map((calendar) => readCalendar(config, calendar, week, runGog)));
  if (reads.some((read) => read.status === "unconfigured")) {
    return { status: "unconfigured", hint: GOG_SETUP_HINT };
  }
  const warnings = reads.flatMap((read) => (read.status === "error" ? [read.message] : []));
  if (warnings.length === reads.length) {
    return { status: "error", message: clip(warnings.join(" "), MESSAGE_MAX) };
  }
  return {
    status: "ok",
    data: reads.flatMap((read) => (read.status === "ok" ? read.events.map(toWire) : [])),
    warnings,
  };
}
