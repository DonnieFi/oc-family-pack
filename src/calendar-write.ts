import { createHash } from "node:crypto";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import { resolveRequester, type Requester } from "./requester.ts";
import type { FamilyStore, WriteLogRow } from "./store.ts";
import type { CalendarConfig, Config } from "./types.ts";
import { addDays, parseDate } from "./week.ts";
import type { GrantHolder } from "./grant.ts";
import { gateWrite } from "./write-gate.ts";

/** The two write-log calls a write needs. The family store is the real one. */
export type WriteLog = Pick<FamilyStore, "countCommittedWrites" | "appendWriteLog">;

export type WriteDeps = {
  config: Pick<Config, "gogPath" | "timezone">;
  runGog: RunGog;
  log: WriteLog;
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

/** Gateway-only: the reply layer strips `eventId` and `key` before anything reaches the page or the model. */
export type CreateResult = { status: "created" | "existing"; eventId: string; key: string };

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
      return requester.senderIsOwner ? "tool:owner" : "tool";
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

/** What the log keeps of a create: the lock's fields only, never the description. */
function loggedFields(fields: ReturnType<typeof normalizeCreate>): string {
  return JSON.stringify({
    summary: fields.title,
    start: fields.start,
    end: fields.end,
    allDay: fields.allDay,
    ...(fields.location ? { location: fields.location } : {}),
  });
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
    const key = requestKey(base, await deps.log.countCommittedWrites(base));
    // A failed row is history only. If writing it fails too, the gog error is the one to surface.
    const logFailure = () => deps.log.appendWriteLog({ ...row, requestKey: key, status: "failed" }, { ifAbsent: false }).catch(() => undefined);
    let live: Awaited<ReturnType<typeof findLive>>;
    try {
      live = await findLive(deps, request.calendarId, base, fields);
    } catch (error) {
      await logFailure();
      throw error;
    }
    if (live) {
      const liveKey = live.key?.startsWith(`${base}.`) ? checkKey(live.key) : key;
      await deps.log.appendWriteLog({ ...row, requestKey: liveKey, eventId: live.eventId, status: "committed" }, { ifAbsent: true });
      return { status: "existing", eventId: live.eventId, key: liveKey };
    }
    let eventId: string;
    try {
      eventId = createdId((await deps.runGog(deps.config.gogPath, createArgs(deps, request, fields, base, key))).stdout);
    } catch (error) {
      await logFailure();
      throw error;
    }
    await deps.log.appendWriteLog({ ...row, requestKey: key, eventId, status: "committed" }, { ifAbsent: false });
    return { status: "created", eventId, key };
  });
}

export type SubmitDeps = Omit<WriteDeps, "config"> & { config: Pick<Config, "gogPath" | "timezone" | "writes" | "members">; grant: GrantHolder };

export type CreateSubmission = {
  /** The host's context. The requester comes only from here; the payload only supplies the page's requestId. */
  context: FeatureInvocationContext;
  payload?: unknown;
  calendar: Pick<CalendarConfig, "id" | "kind" | "owners">;
  fields: CreateFields;
};

export type SubmitResult = { status: "refused"; message: string } | { status: "needs-approval"; approvers: string[] } | CreateResult;

/**
 * The pipeline entry for a create. The gate runs first, so a refusal never reaches gog or
 * the write log. A needs-approval result stops here until approvals land (s5k.34.3).
 */
export async function submitCreate(deps: SubmitDeps, submission: CreateSubmission): Promise<SubmitResult> {
  const requester = resolveRequester(deps.config.members, submission.context);
  const gate = gateWrite({ writes: deps.config.writes, grant: deps.grant.get(), members: deps.config.members, requester, calendar: submission.calendar });
  if (gate.decision === "refused") return { status: "refused", message: gate.message };
  if (gate.decision === "needs-approval") return { status: "needs-approval", approvers: gate.approvers };
  const scope = writeScope(submission.context, submission.payload);
  if (scope === undefined) throw new Error("oc-family-pack: a write needs a retry scope");
  try {
    return await createEvent(deps, { requester: requesterTag(requester), scope, calendarId: submission.calendar.id, fields: submission.fields });
  } catch (error) {
    deps.grant.noteWriteFailure(error);
    throw error;
  }
}
