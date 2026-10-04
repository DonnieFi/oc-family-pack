import { createHash } from "node:crypto";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import { resolveWriteRequester, type Requester } from "./requester.ts";
import type { FamilyStore, WriteLogRow } from "./store.ts";
import type { CalendarConfig, Config } from "./types.ts";
import { addDays, parseDate } from "./week.ts";
import { stderrOf, type GrantHolder } from "./grant.ts";
import type { Seen } from "./approval-stamp.ts";
import { gateWrite, type TableDecision } from "./write-gate.ts";
import { named, OP_VERB, somethingWrongLine, type WriteOp } from "./write-lines.ts";

export { OP_VERB, somethingWrongLine, type WriteOp };

/** The write-log calls a write needs. The family store is the real one. */
export type WriteLog = Pick<FamilyStore, "countCommittedWrites" | "committedWrite" | "appendWriteLog">;

export type WriteDeps = {
  config: Pick<Config, "gogPath" | "timezone">;
  runGog: RunGog;
  log: WriteLog;
  /** The shared grant. A gog write that fails with the read-only grant error flips it. */
  grant: GrantHolder;
};

export type CreateFields = {
  title: string;
  start: string;
  /** An all-day event with no end is one day long, as Bernie's create_all_day_event does (calendar_service.py:389-390). */
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
};

export type CreateRequest = {
  /** From `requesterTag`. */
  requester: string;
  /** From `writeScope`. */
  scope: string;
  /** The Google calendar id. It stays on the Gateway. */
  calendarId: string;
  fields: CreateFields;
};

/**
 * Why a write did not happen: gog's read-only grant error (the grant is now read-only), any
 * other gog failure, or the family store failing before gog ran. A failed row is written where
 * the store still takes one.
 */
export type WriteFailure = "readonly" | "unreachable" | "store" | "stale";

/** Gateway-only: `eventId` and `key` never reach the page or the model; replies are lines. */
export type CreateResult = { status: "created" | "existing"; eventId: string; key: string } | { status: "failed"; reason: WriteFailure };


/** ux's line for a write gog could not make for any reason but the read-only grant. Nothing of gog's own text. */
export const unreachableLine = (op: WriteOp, name: string | undefined) =>
  `I couldn't reach the calendar just now, so I didn't ${OP_VERB[op]} ${named(name)}. Try again in a bit.`;
/** ux's line when the event changed on Google after the hook read it for a parent: named as the parent approved it. */
export const changedWhileWaitingLine = (op: WriteOp, name: string | undefined) =>
  `${name ? `**${name}**` : "That event"} was changed while it was waiting for approval, so I didn't ${OP_VERB[op]} it. Ask again if you still want to.`;
/** END_BEFORE_START for a change. */
export const END_BEFORE_START_CHANGE = "The end has to be after the start. Nothing was changed.";

/** ux's line for a write whose end is not after its start. */
export const END_BEFORE_START = "The end has to be after the start. Nothing was added.";

const KEY_MAX = 256;
const DAY_MS = 86_400_000;
const PAGE_SIZE = "250";

/** Shape checks from Bernie's send_email idempotency key (email_service.py). */
export function checkKey(key: string): string {
  if (key.trim() === "") throw new Error("oc-family-pack: write key must not be blank");
  if (key.length > KEY_MAX) throw new Error(`oc-family-pack: write key must be at most ${KEY_MAX} characters`);
  if (/[\r\n]/.test(key)) throw new Error("oc-family-pack: write key must not contain newlines");
  return key;
}

export function requesterTag(requester: Requester): string {
  switch (requester.from) {
    case "discord":
      return requester.member ? `discord:${requester.member.profileId}` : "discord:unmatched";
    case "tool":
      // Off Discord the owner flag names no person, and the hook can't see it on tools.invoke.
      return "tool";
    case "page":
      return "page";
    case "other":
      return "other";
  }
}

/**
 * What a retry shares with the first try. A tool call uses the message id, else the session
 * key, never the tool call id (a retried turn gets a new one); OpenClaw 2026.9.7 hands a
 * plugin no message id, so today it is the session key. A page action uses the payload's
 * per-submit requestId and never falls back to the session key, so two deliberate adds in
 * one session are two events. The requestId only spots duplicates; it is never identity.
 * No scope means no write.
 */
export function writeScope(context: FeatureInvocationContext, payload?: unknown): string | undefined {
  const key =
    context.source === "tool"
      ? context.tool.sessionKey
      : context.source === "session-action" && isRecord(payload) && typeof payload.requestId === "string"
        ? payload.requestId
        : undefined;
  return key && key.trim() ? key : undefined;
}

function normalizeTime(value: string, allDay: boolean): string {
  const text = value.trim();
  if (allDay) {
    if (parseDate(text) === undefined) throw new Error(`oc-family-pack: an all-day write needs a date, got ${JSON.stringify(text)}`);
    return text;
  }
  const time = Date.parse(text);
  if (parseDate(text) !== undefined || !Number.isFinite(time)) {
    throw new Error(`oc-family-pack: a timed write needs a date and time, got ${JSON.stringify(text)}`);
  }
  return new Date(time).toISOString();
}

/** Same request, same fields: trimmed text, instants in UTC, empty optional text dropped. Key order is fixed. */
export function normalizeCreate(fields: CreateFields): Required<Pick<CreateFields, "title" | "start" | "end" | "allDay">> &
  Pick<CreateFields, "location" | "description"> {
  const allDay = fields.allDay === true;
  if (fields.end === undefined && !allDay) throw new Error("oc-family-pack: a timed write needs an end");
  const start = normalizeTime(fields.start, allDay);
  const normalized: Required<Pick<CreateFields, "title" | "start" | "end" | "allDay">> & Pick<CreateFields, "location" | "description"> = {
    title: fields.title.trim(),
    start,
    end: fields.end === undefined ? addDays(start, 1) : normalizeTime(fields.end, allDay),
    allDay,
  };
  // All-day ends are exclusive dates, so the same day is empty too. ISO dates and UTC instants compare as text.
  if (normalized.end <= normalized.start) throw new Error(END_BEFORE_START);
  const location = fields.location?.trim();
  const description = fields.description?.trim();
  if (location) normalized.location = location;
  if (description) normalized.description = description;
  return normalized;
}

export function baseKey(parts: { requester: string; op: WriteLogRow["op"]; calendarId: string; fields: unknown; scope: string }): string {
  const text = JSON.stringify([parts.requester, parts.op, parts.calendarId, parts.fields, parts.scope]);
  return checkKey(createHash("sha256").update(text).digest("hex"));
}

/** A base key plus how many committed rows already share it, so add, delete, add again is two writes. */
export function requestKey(base: string, committed: number): string {
  return checkKey(`${base}.${committed}`);
}

const held = new Map<string, Promise<void>>();

/** One write per base key at a time in this process: the lookup, the create and the log row run under it. */
export async function withKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = held.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  held.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (held.get(key) === tail) held.delete(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateProps(item: Record<string, unknown>): Record<string, unknown> {
  const props = item.extendedProperties;
  return isRecord(props) && isRecord(props.private) ? props.private : {};
}

/** An event's five logged fields, and what "It was" and "It's now" read from. */
export type EventFields = { title: string; start: string; end: string; allDay: boolean; location?: string };

/** The five fields the log keeps of an event, never the description. */
function fiveFields(fields: EventFields): Record<string, unknown> {
  return { summary: fields.title, start: fields.start, end: fields.end, allDay: fields.allDay, ...(fields.location ? { location: fields.location } : {}) };
}

/** What the log keeps of a create: the five fields. */
export function loggedFields(fields: EventFields): string {
  return JSON.stringify(fiveFields(fields));
}

/** Every value, user text included, rides inside one `--name=value` argv element. */
function flag(name: string, value: string): string {
  return `--${name}=${value}`;
}

/** A day either side of the event, so a timezone slip cannot hide the match. */
function lookupWindow(fields: { start: string; end: string; allDay: boolean }): { from: string; to: string } {
  if (fields.allDay) return { from: addDays(fields.start, -1), to: addDays(fields.end, 1) };
  return {
    from: new Date(Date.parse(fields.start) - DAY_MS).toISOString(),
    to: new Date(Date.parse(fields.end) + DAY_MS).toISOString(),
  };
}

async function findLive(
  deps: WriteDeps,
  calendarId: string,
  base: string,
  fields: { start: string; end: string; allDay: boolean },
): Promise<{ eventId: string; key: string | undefined } | undefined> {
  const { from, to } = lookupWindow(fields);
  const { stdout } = await deps.runGog(deps.config.gogPath, [
    "calendar",
    "events",
    flag("from", from),
    flag("to", to),
    flag("private-prop-filter", `ocfpBase=${base}`),
    "--all-pages",
    "--max",
    PAGE_SIZE,
    "--json",
    "--no-input",
    "--",
    calendarId,
  ]);
  const raw: unknown = JSON.parse(stdout);
  const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.events) ? raw.events : undefined;
  if (!items) throw new Error("oc-family-pack: gog returned an unreadable event list");
  for (const item of items) {
    if (!isRecord(item) || item.status === "cancelled" || typeof item.id !== "string") continue;
    const props = privateProps(item);
    if (props.ocfpBase !== base) continue;
    return { eventId: item.id, key: typeof props.ocfpKey === "string" ? props.ocfpKey : undefined };
  }
  return undefined;
}

function createArgs(deps: WriteDeps, request: CreateRequest, fields: ReturnType<typeof normalizeCreate>, base: string, key: string): string[] {
  return [
    "calendar",
    "create",
    flag("summary", fields.title),
    flag("from", fields.start),
    flag("to", fields.end),
    ...(fields.allDay ? ["--all-day"] : [flag("timezone", deps.config.timezone)]),
    ...(fields.location ? [flag("location", fields.location)] : []),
    ...(fields.description ? [flag("description", fields.description)] : []),
    // gog's default is none today; saying so keeps guests from surprise Google emails if that changes.
    flag("send-updates", "none"),
    flag("private-prop", `ocfpBase=${base}`),
    flag("private-prop", `ocfpKey=${key}`),
    "--json",
    "--no-input",
    "--",
    request.calendarId,
  ];
}

function createdId(stdout: string): string {
  const raw: unknown = JSON.parse(stdout);
  const event = isRecord(raw) && isRecord(raw.event) ? raw.event : raw;
  if (!isRecord(event) || typeof event.id !== "string" || event.id === "") throw new Error("oc-family-pack: gog create returned no event id");
  return event.id;
}

type LoggedRow = Omit<WriteLogRow, "status">;

/** A failed row is history only: if the store won't take it either, the outcome still stands. */
async function logFailed(deps: Pick<WriteDeps, "log">, row: LoggedRow): Promise<void> {
  await deps.log.appendWriteLog({ ...row, status: "failed" }, { ifAbsent: false }).catch(() => undefined);
}

/**
 * gog wrote, so the person gets the success line even if the log write fails. `ifAbsent` is
 * INSERT OR IGNORE for a write found already done; a real write is a plain INSERT, whose
 * throw is caught here. A retry finds the write in Google and logs it then.
 */
async function logCommitted(deps: Pick<WriteDeps, "log">, row: LoggedRow, ifAbsent: boolean): Promise<void> {
  await deps.log.appendWriteLog({ ...row, status: "committed" }, { ifAbsent }).catch(() => undefined);
}

/**
 * gog failed. The grant flips first (the holder's one setter, the shared READONLY_GRANT
 * matcher), so it never waits on the failed row; then the row; then an outcome with none of
 * gog's text.
 */
async function failGog(deps: Pick<WriteDeps, "log" | "grant">, error: unknown, row: LoggedRow): Promise<{ status: "failed"; reason: WriteFailure }> {
  const readonly = deps.grant.noteWriteFailure(error);
  await logFailed(deps, row);
  if (readonly) return { status: "failed", reason: "readonly" };
  return { status: "failed", reason: "unreachable" };
}

/**
 * Creates one event at most once per request. A retry, a second identical call, or a
 * retry after gog succeeded but the log write died finds the event by its `ocfpBase`
 * private property and logs it with INSERT OR IGNORE instead of creating another.
 */
export async function createEvent(deps: WriteDeps, request: CreateRequest): Promise<CreateResult> {
  const fields = normalizeCreate(request.fields);
  const base = baseKey({ requester: request.requester, op: "create", calendarId: request.calendarId, fields, scope: checkKey(request.scope) });
  const row = { baseKey: base, requester: request.requester, op: "create" as const, calendarId: request.calendarId, afterJson: loggedFields(fields) };
  return withKeyLock(base, async () => {
    let key: string;
    try {
      key = requestKey(base, await deps.log.countCommittedWrites(base));
    } catch {
      await logFailed(deps, { ...row, requestKey: requestKey(base, 0) });
      return { status: "failed", reason: "store" };
    }
    const gogFailed = (error: unknown) => failGog(deps, error, { ...row, requestKey: key });
    let live: Awaited<ReturnType<typeof findLive>>;
    try {
      live = await findLive(deps, request.calendarId, base, fields);
    } catch (error) {
      return gogFailed(error);
    }
    if (live) {
      const liveKey = live.key?.startsWith(`${base}.`) ? checkKey(live.key) : key;
      await logCommitted(deps, { ...row, requestKey: liveKey, eventId: live.eventId }, true);
      return { status: "existing", eventId: live.eventId, key: liveKey };
    }
    let eventId: string;
    try {
      eventId = createdId((await deps.runGog(deps.config.gogPath, createArgs(deps, request, fields, base, key))).stdout);
    } catch (error) {
      return gogFailed(error);
    }
    await logCommitted(deps, { ...row, requestKey: key, eventId }, false);
    return { status: "created", eventId, key };
  });
}

// ---- update, move, delete ----

export type ChangeOp = Exclude<WriteOp, "create">;
/** Which part of a repeating event: this one, this one and every later one, or all of it. */
export type SeriesScope = "single" | "future" | "all";

export type ChangeFields = { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; description?: string };

export type ChangeRequest = {
  /** From `requesterTag`. */
  requester: string;
  /** From `writeScope`. */
  scope: string;
  op: ChangeOp;
  /** The Google calendar and event ids, resolved from a wire id on the Gateway. */
  calendarId: string;
  eventId: string;
  /** update: what changes. */
  fields?: ChangeFields;
  /** move: the Google id of the calendar it moves to. */
  destinationId?: string;
  /** For a repeating event's occurrence. Its original start is in its event id. */
  series?: SeriesScope;
  /** What a parent approved: the event's version and name as the hook read them. Never part of the key. */
  approved?: Seen;
};

/**
 * `before` is the event as it was and `after` as it is now (the same for move and delete).
 * `seriesFrom` is set for a change to a repeating event's later or every occurrence.
 */
export type ChangeResult =
  | { status: "changed" | "existing"; eventId: string; key: string; before: EventFields; after: EventFields; seriesFrom?: string }
  | { status: "not-found"; title?: string }
  | { status: "invalid"; message: string }
  | { status: "failed"; reason: WriteFailure; title?: string };

/** An update that names nothing to change. */
export const NOTHING_TO_CHANGE = "oc-family-pack: an update needs something to change";

/** Same rule as a create: trimmed text, instants in UTC, a date-only time is all-day. Key order is fixed. */
export function normalizeChange(fields: ChangeFields): ChangeFields {
  const out: ChangeFields = {};
  const title = fields.title?.trim();
  if (title) out.title = title;
  const shape = fields.start ?? fields.end;
  const allDay = fields.allDay ?? (shape === undefined ? undefined : parseDate(shape.trim()) !== undefined);
  if (fields.start !== undefined) out.start = normalizeTime(fields.start, allDay === true);
  if (fields.end !== undefined) out.end = normalizeTime(fields.end, allDay === true);
  if (allDay !== undefined) out.allDay = allDay;
  if (out.start !== undefined && out.end !== undefined && out.end <= out.start) throw new Error(END_BEFORE_START);
  const location = fields.location?.trim();
  const description = fields.description?.trim();
  if (location) out.location = location;
  if (description) out.description = description;
  if (Object.keys(out).length === 0) throw new Error(NOTHING_TO_CHANGE);
  return out;
}

/** The change's key: everything that makes it this change, and the retry scope. A create's key is unchanged. */
export function changeBaseKey(request: ChangeRequest): string {
  const changes = request.op === "update" ? normalizeChange(request.fields ?? {}) : request.op === "move" ? { destination: request.destinationId ?? "" } : {};
  const text = JSON.stringify([
    request.requester,
    request.op,
    request.calendarId,
    request.eventId,
    changes,
    request.series ?? null,
    checkKey(request.scope),
  ]);
  return checkKey(createHash("sha256").update(text).digest("hex"));
}

type Snapshot = EventFields & { eventId: string; description?: string; recurringEventId?: string; originalStart?: string };
export type Lookup =
  | { status: "found"; event: Snapshot; raw: Record<string, unknown>; version?: string }
  | { status: "gone"; event?: Snapshot }
  | { status: "missing"; event?: undefined };

/** What changes whenever Google changes the event: its etag, else its updated time. */
function versionOf(item: Record<string, unknown>): string | undefined {
  for (const value of [item.etag, item.updated]) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

const GONE = /\b410\b|\bgone\b|has been deleted/i;
const NOT_FOUND = /\b404\b|notFound|not found/i;

function readWhen(value: unknown): { at: string; allDay: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.dateTime === "string" && Number.isFinite(Date.parse(value.dateTime))) return { at: new Date(value.dateTime).toISOString(), allDay: false };
  if (typeof value.date === "string" && parseDate(value.date) !== undefined) return { at: value.date, allDay: true };
  return undefined;
}

function readSnapshot(item: unknown): Snapshot | undefined {
  if (!isRecord(item) || typeof item.id !== "string") return undefined;
  const start = readWhen(item.start);
  const end = readWhen(item.end) ?? start;
  if (!start || !end) return undefined;
  const event: Snapshot = { eventId: item.id, title: typeof item.summary === "string" ? item.summary : "", start: start.at, end: end.at, allDay: start.allDay };
  if (typeof item.location === "string" && item.location.trim()) event.location = item.location.trim();
  if (typeof item.description === "string" && item.description.trim()) event.description = item.description.trim();
  if (typeof item.recurringEventId === "string" && item.recurringEventId) event.recurringEventId = item.recurringEventId;
  const original = readWhen(item.originalStartTime);
  if (original) event.originalStart = original.at;
  return event;
}

/** One event by id. A 404 is missing; a 410 or a cancelled event is gone. Anything else is gog's failure. */
export async function getEvent(deps: Pick<WriteDeps, "config" | "runGog">, calendarId: string, eventId: string): Promise<Lookup> {
  let stdout: string;
  try {
    ({ stdout } = await deps.runGog(deps.config.gogPath, ["calendar", "event", "--json", "--no-input", "--", calendarId, eventId]));
  } catch (error) {
    const stderr = stderrOf(error);
    if (GONE.test(stderr)) return { status: "gone" };
    if (NOT_FOUND.test(stderr)) return { status: "missing" };
    throw error;
  }
  const raw: unknown = JSON.parse(stdout);
  const item = isRecord(raw) && isRecord(raw.event) ? raw.event : raw;
  const event = readSnapshot(item);
  if (isRecord(item) && item.status === "cancelled") return event ? { status: "gone", event } : { status: "gone" };
  if (!event || !isRecord(item)) throw new Error("oc-family-pack: gog returned an unreadable event");
  const version = versionOf(item);
  return { status: "found", event, raw: item, ...(version ? { version } : {}) };
}

/** Moves the end with the start when only the start changes, so the event keeps its length. */
export function applyChange(before: Snapshot, change: ChangeFields): EventFields & { description?: string } {
  const allDay = change.allDay ?? before.allDay;
  const start = change.start ?? before.start;
  let end = change.end;
  if (end === undefined) {
    if (change.start === undefined && allDay === before.allDay) end = before.end;
    else if (allDay !== before.allDay) end = allDay ? addDays(start, 1) : new Date(Date.parse(start) + 3_600_000).toISOString();
    else if (allDay) end = addDays(start, Math.round(((parseDate(before.end) ?? 0) - (parseDate(before.start) ?? 0)) / DAY_MS));
    else end = new Date(Date.parse(start) + (Date.parse(before.end) - Date.parse(before.start))).toISOString();
  }
  const after: EventFields & { description?: string } = { title: change.title ?? before.title, start, end, allDay };
  const location = change.location ?? before.location;
  if (location) after.location = location;
  const description = change.description ?? before.description;
  if (description) after.description = description;
  return after;
}

function sameEvent(before: Snapshot, after: EventFields & { description?: string }): boolean {
  return (
    before.title === after.title &&
    before.start === after.start &&
    before.end === after.end &&
    before.allDay === after.allDay &&
    (before.location ?? "") === (after.location ?? "") &&
    (before.description ?? "") === (after.description ?? "")
  );
}

/** The event gog writes to and its series flags: a repeating event's later or every occurrence goes through its series. */
function target(event: Snapshot, series: SeriesScope | undefined): { eventId: string; flags: string[] } {
  if (!event.recurringEventId) return { eventId: event.eventId, flags: [] };
  const scope = series ?? "single";
  if (scope === "single") return { eventId: event.eventId, flags: [] };
  const original = event.originalStart ?? event.start;
  return { eventId: event.recurringEventId, flags: [flag("scope", scope), ...(scope === "future" ? [flag("original-start", original)] : [])] };
}

function updateArgs(calendarId: string, to: { eventId: string; flags: string[] }, change: ChangeFields, after: EventFields & { description?: string }): string[] {
  const times = change.start !== undefined || change.end !== undefined || change.allDay !== undefined;
  return [
    "calendar",
    "update",
    ...(change.title !== undefined ? [flag("summary", after.title)] : []),
    ...(times ? [flag("from", after.start), flag("to", after.end), ...(after.allDay ? ["--all-day"] : [])] : []),
    ...(change.location !== undefined ? [flag("location", change.location)] : []),
    ...(change.description !== undefined ? [flag("description", change.description)] : []),
    ...to.flags,
    flag("send-updates", "none"),
    "--json",
    "--no-input",
    "--",
    calendarId,
    to.eventId,
  ];
}

function readLogged(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fieldsFromLog(logged: Record<string, unknown>): EventFields | undefined {
  const { summary, start, end, allDay, location } = logged;
  if (typeof summary !== "string" || typeof start !== "string" || typeof end !== "string" || typeof allDay !== "boolean") return undefined;
  return { title: summary, start, end, allDay, ...(typeof location === "string" ? { location } : {}) };
}

/**
 * Updates, moves or deletes one event at most once per request, under the base key's lock:
 * 1. a committed row for the request key is the answer, with no gog call;
 * 2. the event is read; a 404 is not found and writes no row (for a move, the destination
 *    is checked first, in case the move already happened);
 * 3. a deleted or cancelled event is not found and writes no row, except for a delete a parent
 *    approved, which is done;
 * 4. (the stamp's MAC, version included, was checked by the tool before the gate);
 * 5. a parent-approved change whose event has another version now is refused with ux's
 *    changed-while-waiting line and a failed row holding the event as it is now;
 * 6. an update the event already matches is logged with INSERT OR IGNORE and answered as existing;
 * 7. otherwise gog writes and the row is a plain INSERT.
 * Known gap: the window between this read and gog's write stays open. gog has no If-Match, and
 * the key's lock only orders our own writes.
 * before_json is the event's five fields (plus the series' recurrence and start for a
 * repeating change); after_json is the update's five fields, the move's destination, and the
 * series scope and original start.
 */
/**
 * ux: an event already deleted (410) or cancelled when we first look is not found and logs
 * nothing, like a 404. Only a delete a parent approved counts it as done, since it was there
 * when they approved. A retry of a committed request is done by step 1.
 */
const goneIsDone = (request: ChangeRequest) => request.op === "delete" && request.approved !== undefined;

export async function changeEvent(deps: WriteDeps, request: ChangeRequest): Promise<ChangeResult> {
  let change: ChangeFields = {};
  if (request.op === "update") {
    try {
      change = normalizeChange(request.fields ?? {});
    } catch (error) {
      if (error instanceof Error && error.message === END_BEFORE_START) return { status: "invalid", message: END_BEFORE_START_CHANGE };
      throw error;
    }
  }
  const base = changeBaseKey(request);
  const key = requestKey(base, 0);
  const row: LoggedRow = { requestKey: key, baseKey: base, requester: request.requester, op: request.op, calendarId: request.calendarId, eventId: request.eventId };
  return withKeyLock(base, async (): Promise<ChangeResult> => {
    let committed: Awaited<ReturnType<WriteLog["committedWrite"]>>;
    try {
      committed = await deps.log.committedWrite(key);
    } catch {
      await logFailed(deps, row);
      // Only for the event's name in the line; gog writes nothing.
      const title = await getEvent(deps, request.calendarId, request.eventId).then(
        (found) => found.event?.title,
        () => undefined,
      );
      return { status: "failed", reason: "store", ...(title ? { title } : {}) };
    }
    if (committed) {
      const loggedBefore = readLogged(committed.beforeJson);
      const loggedAfter = readLogged(committed.afterJson);
      const before = fieldsFromLog(loggedBefore);
      if (before) {
        const after = request.op === "update" ? (fieldsFromLog(loggedAfter) ?? before) : before;
        const from = seriesFromLog(request.series, loggedBefore, loggedAfter);
        return { status: "existing", eventId: committed.eventId ?? request.eventId, key, before, after, ...(from ? { seriesFrom: from } : {}) };
      }
    }
    const gogFailed = async (error: unknown, extra: Partial<LoggedRow> = {}, title?: string): Promise<ChangeResult> => ({
      ...(await failGog(deps, error, { ...row, ...extra })),
      ...(title ? { title } : {}),
    });
    let found: Lookup;
    try {
      found = await getEvent(deps, request.calendarId, request.eventId);
      if (found.status !== "found" && request.op === "move" && request.destinationId) {
        const moved = await getEvent(deps, request.destinationId, request.eventId);
        if (moved.status === "found") {
          const before = pick(moved.event);
          const logged = { ...row, beforeJson: JSON.stringify(fiveFields(before)), afterJson: JSON.stringify({ calendarId: request.destinationId }) };
          await logCommitted(deps, logged, true);
          return { status: "existing", eventId: request.eventId, key, before, after: before };
        }
      }
    } catch (error) {
      return gogFailed(error);
    }
    if (found.status === "missing" || (found.status === "gone" && (!goneIsDone(request) || !found.event))) {
      const title = found.event?.title ?? request.approved?.title;
      return title ? { status: "not-found", title } : { status: "not-found" };
    }
    const event = found.event!;
    const before = pick(event);
    let series: { recurrence: string[]; start: string } | undefined;
    if (request.series && request.series !== "single" && event.recurringEventId) {
      try {
        series = await seriesOf(deps, request.calendarId, event.recurringEventId);
      } catch (error) {
        return gogFailed(error, {}, event.title);
      }
    }
    const beforeJson = JSON.stringify({ ...fiveFields(before), ...(series ? { recurrence: series.recurrence, seriesStart: series.start } : {}) });
    const seriesNote = series ? { scope: request.series, originalStart: event.originalStart ?? event.start } : undefined;
    const seriesFrom = series ? (request.series === "all" ? series.start : seriesNote?.originalStart) : undefined;
    const answer = (status: "changed" | "existing", after: EventFields): ChangeResult => ({
      status,
      eventId: request.eventId,
      key,
      before,
      after,
      ...(seriesFrom ? { seriesFrom } : {}),
    });
    const withBefore = { ...row, beforeJson };
    if (found.status === "gone") {
      await logCommitted(deps, { ...withBefore, ...(seriesNote ? { afterJson: JSON.stringify(seriesNote) } : {}) }, true);
      return answer("existing", before);
    }
    if (request.approved && request.approved.version !== found.version) {
      await logFailed(deps, withBefore);
      return { status: "failed", reason: "stale", title: request.approved.title };
    }
    const to = target(event, request.series);
    if (request.op === "update") {
      const after = applyChange(event, change);
      if (after.end <= after.start) return { status: "invalid", message: END_BEFORE_START_CHANGE };
      const logged = { ...withBefore, afterJson: JSON.stringify({ ...fiveFields(after), ...(seriesNote ?? {}) }) };
      if (sameEvent(event, after)) {
        await logCommitted(deps, logged, true);
        return answer("existing", pick(after));
      }
      try {
        await deps.runGog(deps.config.gogPath, updateArgs(request.calendarId, to, change, after));
      } catch (error) {
        return gogFailed(error, { beforeJson }, event.title);
      }
      await logCommitted(deps, logged, false);
      return answer("changed", pick(after));
    }
    if (request.op === "move") {
      const destination = request.destinationId ?? "";
      try {
        await deps.runGog(deps.config.gogPath, ["calendar", "move", flag("send-updates", "none"), "--json", "--no-input", "--", request.calendarId, event.eventId, destination]);
      } catch (error) {
        return gogFailed(error, { beforeJson }, event.title);
      }
      await logCommitted(deps, { ...withBefore, afterJson: JSON.stringify({ calendarId: destination }) }, false);
      return answer("changed", before);
    }
    const deleted = { ...withBefore, ...(seriesNote ? { afterJson: JSON.stringify(seriesNote) } : {}) };
    try {
      await deps.runGog(deps.config.gogPath, ["calendar", "delete", ...to.flags, flag("send-updates", "none"), "--force", "--no-input", "--", request.calendarId, to.eventId]);
    } catch (error) {
      if (!GONE.test(stderrOf(error))) return gogFailed(error, { beforeJson }, event.title);
      await logCommitted(deps, deleted, true);
      return answer("existing", before);
    }
    await logCommitted(deps, deleted, false);
    return answer("changed", before);
  });
}

function pick(event: EventFields): EventFields {
  return { title: event.title, start: event.start, end: event.end, allDay: event.allDay, ...(event.location ? { location: event.location } : {}) };
}

function seriesFromLog(series: SeriesScope | undefined, before: Record<string, unknown>, after: Record<string, unknown>): string | undefined {
  if (!series || series === "single" || !Array.isArray(before.recurrence)) return undefined;
  const from = series === "all" ? before.seriesStart : after.originalStart;
  return typeof from === "string" ? from : undefined;
}

/** The repeating event's own recurrence lines (RRULE, EXDATE) and its first start. */
async function seriesOf(deps: WriteDeps, calendarId: string, seriesId: string): Promise<{ recurrence: string[]; start: string }> {
  const found = await getEvent(deps, calendarId, seriesId);
  if (found.status !== "found") throw new Error("oc-family-pack: the series is gone");
  const recurrence = Array.isArray(found.raw.recurrence) ? found.raw.recurrence.filter((line): line is string => typeof line === "string") : [];
  return { recurrence, start: found.event.start };
}

export type ChangeSubmission = {
  context: FeatureInvocationContext;
  payload?: unknown;
  op: ChangeOp;
  calendar: Pick<CalendarConfig, "id" | "kind" | "owners">;
  eventId: string;
  fields?: ChangeFields;
  /** move: the calendar it goes to. The table must allow this one too. */
  destination?: Pick<CalendarConfig, "id" | "kind" | "owners">;
  series?: SeriesScope;
  table?: TableDecision;
  /** What a parent approved, from the hook's stamp. */
  approved?: Seen;
};

/** The pipeline entry for update, move and delete: the gate (source and destination), then changeEvent. */
export async function submitChange(deps: SubmitDeps, submission: ChangeSubmission): Promise<SubmitChangeResult> {
  const requester = resolveWriteRequester(deps.config.members, submission.context);
  const gate = gateWrite({
    writes: deps.config.writes,
    grant: deps.grant.get(),
    members: deps.config.members,
    requester,
    calendar: submission.calendar,
    ...(submission.destination ? { destination: submission.destination } : {}),
    ...(submission.table ? { table: submission.table } : {}),
  });
  if (gate.decision === "refused") return { status: "refused", message: gate.message };
  if (gate.decision === "needs-approval") return { status: "needs-approval", approvers: gate.approvers };
  const scope = writeScope(submission.context, submission.payload);
  if (scope === undefined) throw new Error("oc-family-pack: a write needs a retry scope");
  return changeEvent(deps, {
    requester: requesterTag(requester),
    scope,
    op: submission.op,
    calendarId: submission.calendar.id,
    eventId: submission.eventId,
    ...(submission.fields ? { fields: submission.fields } : {}),
    ...(submission.destination ? { destinationId: submission.destination.id } : {}),
    ...(submission.series ? { series: submission.series } : {}),
    ...(submission.approved ? { approved: submission.approved } : {}),
  });
}

export type SubmitChangeResult = { status: "refused"; message: string } | { status: "needs-approval"; approvers: string[] } | ChangeResult;

export type SubmitDeps = Omit<WriteDeps, "config"> & { config: Pick<Config, "gogPath" | "timezone" | "writes" | "members"> };

export type CreateSubmission = {
  /** The host's context. The requester comes only from here; the payload only supplies the page's requestId. */
  context: FeatureInvocationContext;
  payload?: unknown;
  calendar: Pick<CalendarConfig, "id" | "kind" | "owners">;
  fields: CreateFields;
  /**
   * The permission table's answer, from code only: the calendar_create tool passes what its
   * verified stamp says the before_tool_call hook decided. With it, only gate 0, off and
   * read-only run again; without it, the whole gate runs.
   */
  table?: TableDecision;
};

export type SubmitResult = { status: "refused"; message: string } | { status: "needs-approval"; approvers: string[] } | CreateResult;

/**
 * The pipeline entry for a create. The gate runs first, so a refusal never reaches gog or
 * the write log. A needs-approval result stops here; tool calls get their approval from the
 * before_tool_call hook (calendar-create.ts) and come back with `table`.
 */
export async function submitCreate(deps: SubmitDeps, submission: CreateSubmission): Promise<SubmitResult> {
  const requester = resolveWriteRequester(deps.config.members, submission.context);
  const gate = gateWrite({
    writes: deps.config.writes,
    grant: deps.grant.get(),
    members: deps.config.members,
    requester,
    calendar: submission.calendar,
    ...(submission.table ? { table: submission.table } : {}),
  });
  if (gate.decision === "refused") return { status: "refused", message: gate.message };
  if (gate.decision === "needs-approval") return { status: "needs-approval", approvers: gate.approvers };
  const scope = writeScope(submission.context, submission.payload);
  if (scope === undefined) throw new Error("oc-family-pack: a write needs a retry scope");
  return createEvent(deps, { requester: requesterTag(requester), scope, calendarId: submission.calendar.id, fields: submission.fields });
}
