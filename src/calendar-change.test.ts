import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Value } from "typebox/value";
import { createStamper, STAMP_PARAM } from "./approval-stamp.ts";
import {
  CalendarDeleteInputSchema,
  CalendarMoveInputSchema,
  calendarChangeTool,
  CalendarUpdateInputSchema,
  NO_SUCH_EVENT,
  NOTHING_CHANGED,
  prepareChange,
  UNREADABLE_TIME,
} from "./calendar-change.ts";
import {
  CalendarCreateInputSchema,
  factsFromTool,
  type CalendarWriteDeps,
  type HookContext,
  type HookEvent,
  type HookResult,
  type ToolContext,
  type CalendarTool,
  type ApprovalResolution,
} from "./calendar-create.ts";
import type { RunGog } from "./calendar-gog.ts";
import { registerCalendarWrite, type CalendarWriteApi } from "./calendar-tools.ts";
import { END_BEFORE_START_CHANGE, submitChange, type WriteLog } from "./calendar-write.ts";
import { parseConfig } from "./config.ts";
import { grantHolder, type GrantHolder } from "./grant.ts";
import { pageWrite, type PageWriteResult } from "./page-write.ts";
import type { WriteLogRow } from "./store.ts";
import { CalendarWriteSchema } from "./contract.ts";
import type { CalendarWrite, Config } from "./types.ts";
import { READ_ONLY, VIEW_ONLY } from "./write-gate.ts";

const GOG = "/nonexistent/ocfp-test/gog";
const DONNIE_ID = "100000000000000001";
const CALLA_ID = "100000000000000002";
const DONNIE_CAL = "donnie@example.com";
const FAMILY_CAL = "family@group.calendar.google.com";
const CALLA_CAL = "calla@example.com";

function household(writes: "on" | "confirm" | "off" = "on"): Config {
  return parseConfig({
    timezone: "America/Halifax",
    writes,
    gogPath: GOG,
    members: [
      { profileId: "donnie", displayName: "Donnie", role: "parent", discordId: DONNIE_ID },
      { profileId: "calla", displayName: "Calla", role: "kid", discordId: CALLA_ID },
    ],
    calendars: [
      { id: DONNIE_CAL, label: "Donnie", kind: "personal", owners: ["donnie"] },
      { id: FAMILY_CAL, label: "Family", kind: "shared", owners: ["donnie", "calla"] },
      { id: CALLA_CAL, label: "Calla", kind: "personal", owners: ["calla"] },
    ],
  });
}

type Event = { id: string; calendarId: string; summary: string; start: string; end: string; status: string; etag?: string | undefined; updated?: string | undefined; recurringEventId?: string; originalStart?: string; recurrence?: string[] };

const gogError = (stderr: string) => Object.assign(new Error(`Command failed: gog\n${stderr}`), { stderr, code: 1 });
const READONLY_STDERR = "Error: googleapi: Error 403: Request had insufficient authentication scopes., insufficientPermissions";
const SECRET_STORE_TEXT = "SQLITE_IOERR: disk I/O error at /var/lib/secret.sqlite";

/** A stand-in gog for event, update, move and delete, and a bare events and create. No real gog is reachable. Every write bumps the event's etag and updated time, as Google does. */
function fakeGog() {
  const events: Event[] = [];
  let versions = 1;
  const calls: string[][] = [];
  const fail = new Map<string, () => Error>();
  const flag = (args: string[], name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const run: RunGog = async (file, args) => {
    assert.equal(file, GOG);
    calls.push(args);
    const failure = fail.get(args[1] ?? "");
    if (failure) throw failure();
    const dash = args.indexOf("--");
    const [calendarId, eventId, destination] = args.slice(dash + 1);
    if (args[1] === "events") return { stdout: JSON.stringify({ events: [] }) };
    if (args[1] === "create") {
      const created: Event = { id: `ev${events.length + 1}`, calendarId: calendarId ?? "", summary: flag(args, "summary") ?? "", start: flag(args, "from") ?? "", end: flag(args, "to") ?? "", status: "confirmed" };
      events.push(created);
      return { stdout: JSON.stringify({ event: { id: created.id } }) };
    }
    const event = events.find((entry) => entry.id === eventId && entry.calendarId === calendarId);
    if (!event) throw gogError("Error: googleapi: Error 404: Not Found, notFound");
    const resource = () => ({
      id: event.id,
      status: event.status,
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      ...(event.recurringEventId ? { recurringEventId: event.recurringEventId, originalStartTime: { dateTime: event.originalStart } } : {}),
      ...(event.recurrence ? { recurrence: event.recurrence } : {}),
      ...(event.etag ? { etag: event.etag } : {}),
      ...(event.updated ? { updated: event.updated } : {}),
    });
    if (args[1] === "event") return { stdout: JSON.stringify({ event: resource() }) };
    assert.ok(args.includes("--send-updates=none"), JSON.stringify(args));
    if (event.status === "cancelled") throw gogError("Error: googleapi: Error 410: Resource has been deleted, deleted");
    versions += 1;
    if (event.etag) event.etag = `"v${versions}"`;
    if (event.updated) event.updated = new Date(Date.parse(event.updated) + 60_000).toISOString();
    if (args[1] === "delete") event.status = "cancelled";
    else if (args[1] === "move") event.calendarId = destination ?? "";
    // A series change rewrites occurrences Google keeps; the master's own start stays.
    else if (args[1] === "update" && flag(args, "scope") !== undefined) event.summary = flag(args, "summary") ?? event.summary;
    else if (args[1] === "update") {
      event.summary = flag(args, "summary") ?? event.summary;
      event.start = flag(args, "from") ?? event.start;
      event.end = flag(args, "to") ?? event.end;
    } else throw new Error(`the stand-in gog has no ${args[1]}`);
    return { stdout: JSON.stringify({ event: resource() }) };
  };
  const writes = () => calls.filter((args) => ["create", "update", "move", "delete"].includes(args[1] ?? ""));
  return { run, events, calls, fail, writes };
}

/** The write log in memory, with switches for the two store failures. */
function memoryLog() {
  const rows: WriteLogRow[] = [];
  const failAt = { lookup: false, committed: false, any: false };
  const log: WriteLog & { rows: WriteLogRow[] } = {
    rows,
    countCommittedWrites: async (base) => {
      if (failAt.lookup) throw new Error(SECRET_STORE_TEXT);
      return rows.filter((row) => row.baseKey === base && row.status === "committed").length;
    },
    committedWrite: async (key) => {
      if (failAt.lookup) throw new Error(SECRET_STORE_TEXT);
      const row = rows.find((entry) => entry.requestKey === key && entry.status === "committed");
      return row ? { eventId: row.eventId ?? null, beforeJson: row.beforeJson ?? null, afterJson: row.afterJson ?? null } : undefined;
    },
    appendWriteLog: async (row) => {
      if (failAt.any || (failAt.committed && row.status === "committed")) throw new Error(SECRET_STORE_TEXT);
      if (row.status === "committed" && rows.some((entry) => entry.requestKey === row.requestKey && entry.status === "committed")) throw new Error("UNIQUE constraint failed");
      rows.push(row);
      return { inserted: true };
    },
  };
  return { log, failAt };
}

type Registered = { handler: (event: HookEvent, ctx: HookContext) => Promise<HookResult | undefined> };

function setup(options: { writes?: "on" | "confirm" | "off"; grant?: GrantHolder; noStore?: boolean } = {}) {
  const config = household(options.writes);
  const gog = fakeGog();
  const { log, failAt } = memoryLog();
  const grant = options.grant ?? grantHolder();
  const hooks: Registered[] = [];
  const tools = new Map<string, (ctx: ToolContext) => CalendarTool>();
  const api: CalendarWriteApi = {
    on: (_name, handler) => hooks.push({ handler }),
    registerTool: (factory, opts) => tools.set(opts.name, factory),
  };
  const deps: CalendarWriteDeps = { config, runGog: gog.run, grant, log: () => (options.noStore ? undefined : log) };
  registerCalendarWrite(api, deps);
  const changed: string[][] = [];
  const page = pageWrite({ config, runGog: gog.run, grant, log: deps.log, changed: (keys) => changed.push(keys) });
  return { config, gog, log, failAt, grant, hooks, tools, page, changed, deps };
}
type Setup = ReturnType<typeof setup>;

let sessions = 0;
function discord(senderId: string, toolName: string) {
  sessions += 1;
  const sessionKey = `agent:main:discord:channel:${sessions}`;
  return {
    hook: { toolName, sessionKey, requester: { channel: "discord", senderId, senderIsOwner: false } } as HookContext,
    tool: { sessionKey, messageChannel: "discord", requesterSenderId: senderId, senderIsOwner: false } as ToolContext,
  };
}

type Outcome = { blocked?: string; text?: string; approval?: NonNullable<HookResult["requireApproval"]> };

/**
 * One tool call the way the host runs it: our hook first, then approval, then the tool with the
 * hook's params. `between` runs after the decision and before the tool, as a change made on
 * Google while the approval waited.
 */
async function call(
  s: Setup,
  toolName: string,
  senderId: string,
  params: Record<string, unknown>,
  decide: ApprovalResolution = "allow-once",
  options: { between?: () => void; caller?: ReturnType<typeof discord> } = {},
): Promise<Outcome> {
  const caller = options.caller ?? discord(senderId, toolName);
  const result = await s.hooks[0]!.handler({ toolName, params: structuredClone(params) }, caller.hook);
  if (result?.block) return { blocked: result.blockReason ?? "blocked" };
  const outcome: Outcome = {};
  if (result?.requireApproval) {
    outcome.approval = result.requireApproval;
    await result.requireApproval.onResolution(decide);
    if (decide === "timeout") return { ...outcome, blocked: result.requireApproval.timeoutReason };
    if (decide !== "allow-once") return { ...outcome, blocked: `host:${decide}` };
  }
  options.between?.();
  const tool = s.tools.get(toolName)!(caller.tool);
  const done = await tool.execute("call-1", { ...params, ...(result?.params ?? {}) });
  return { ...outcome, text: done.content[0]!.text };
}

function seed(s: Setup, overrides: Partial<Event> = {}): Event {
  const event: Event = { id: `ev${s.gog.events.length + 1}`, calendarId: DONNIE_CAL, summary: "Dentist", start: "2026-10-14T13:00:00.000Z", end: "2026-10-14T14:00:00.000Z", status: "confirmed", etag: '"v1"', ...overrides };
  s.gog.events.push(event);
  return event;
}
const wire = (key: string, event: Event) => `${key}/${event.id}`;

const CHANGED = "Changed **Dentist (Calla)** on Donnie's calendar. It's now Wednesday October 14 at 10:00 AM.";
const MOVED_TIME = "Moved **Dentist** on Donnie's calendar to Thursday October 15 at 2:00 PM. It was Wednesday October 14 at 10:00 AM.";
const DELETED = "Deleted **Dentist** from Donnie's calendar. It was Wednesday October 14 at 10:00 AM.";
const MOVED_FAMILY = "Moved **Dentist** from Donnie's calendar to the Family calendar. It's still Wednesday October 14 at 10:00 AM.";

// ---- The tools ----

test("ux's change, time-only and delete lines, with no id or key in them", async () => {
  const s = setup();
  const a = seed(s);
  const b = seed(s);
  const c = seed(s);
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", a), title: "Dentist (Calla)" }), { text: CHANGED });
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", b), start: "2026-10-15T14:00:00-03:00" }), { text: MOVED_TIME });
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", c) }), { text: DELETED });
  assert.equal(b.end, "2026-10-15T18:00:00.000Z");
  assert.deepEqual(s.log.rows.map((row) => [row.op, row.status, row.eventId]), [["update", "committed", a.id], ["update", "committed", b.id], ["delete", "committed", c.id]]);
});

test("a repeating event's later or every occurrence gets the series line; one occurrence the normal line", async () => {
  const s = setup();
  seed(s, { id: "swim", calendarId: CALLA_CAL, summary: "Swim", start: "2026-10-06T21:00:00.000Z", end: "2026-10-06T22:00:00.000Z", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] });
  for (const date of ["13", "20", "27"]) {
    const at = `2026-10-${date}T21:00:00.000Z`;
    seed(s, { id: `swim_${date}`, calendarId: CALLA_CAL, summary: "Swim", start: at, end: `2026-10-${date}T22:00:00.000Z`, recurringEventId: "swim", originalStart: at });
  }
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: "c2/swim_13", start: "2026-10-13T17:30:00-03:00", scope: "future" }), {
    text: "Changed every **Swim** on Calla's calendar from Tuesday October 13 on.",
  });
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: "c2/swim_20", scope: "all" }), { text: "Deleted every **Swim** on Calla's calendar from Tuesday October 6 on." });
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: "c2/swim_27" }), { text: "Deleted **Swim** from Calla's calendar. It was Tuesday October 27 at 6:00 PM." });
});

test("not found: an unknown wire id or a 404 says so without a name; a deleted event says its name; neither writes a row", async () => {
  const s = setup();
  const gone = seed(s, { status: "cancelled" });
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: "c9/ev1" }), { blocked: NO_SUCH_EVENT });
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: "c0/nope", title: "X" }), { text: NO_SUCH_EVENT });
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", gone), title: "X" }), { text: "I couldn't find **Dentist** on Donnie's calendar, so nothing changed." });
  assert.deepEqual(s.log.rows, []);
  assert.deepEqual(s.gog.writes(), []);
});

test("a move between calendars says both calendars and that the time stays, and needs the table to allow both", async () => {
  const s = setup();
  const mine = seed(s);
  assert.deepEqual(await call(s, "calendar_move", DONNIE_ID, { event: wire("c0", mine), calendar: "Family" }), { text: MOVED_FAMILY });
  assert.equal(mine.calendarId, FAMILY_CAL);
  // Calla may write her own calendar but not the Family one, so her move asks a parent.
  const hers = seed(s, { calendarId: CALLA_CAL, summary: "Sleepover" });
  const asked = await call(s, "calendar_move", CALLA_ID, { event: wire("c2", hers), calendar: "Family" }, "deny");
  assert.equal(asked.approval?.title, "Calla wants to move **Sleepover** to the Family calendar");
  assert.equal(asked.approval?.description, "Calla asked on Discord. Sleepover, Wednesday October 14 at 10:00 AM. Moving from Calla's calendar to the Family calendar.");
  assert.equal(hers.calendarId, CALLA_CAL);
  // The mirror: Calla's own calendar is fine as the destination, but the Family source still needs a parent.
  const family = seed(s, { calendarId: FAMILY_CAL, summary: "Bake sale" });
  const back = await call(s, "calendar_move", CALLA_ID, { event: wire("c1", family), calendar: "Calla" }, "deny");
  assert.equal(back.approval?.title, "Calla wants to move **Bake sale** to Calla's calendar");
  assert.equal(family.calendarId, FAMILY_CAL);
});

test("a kid's change waits for a parent: the approval names the event and when it is, and deny and timeout log their rows", async () => {
  const s = setup();
  const event = seed(s, { calendarId: FAMILY_CAL });
  const denied = await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", event) }, "deny");
  assert.equal(denied.approval?.title, "Calla wants to delete **Dentist** from the Family calendar");
  assert.equal(denied.approval?.description, "Calla asked on Discord. Dentist, Wednesday October 14 at 10:00 AM, on the Family calendar.");
  const timedOut = await call(s, "calendar_update", CALLA_ID, { event: wire("c1", event), title: "Dentist (Calla)" }, "timeout");
  assert.equal(timedOut.blocked, "Nobody answered in 10 minutes, so I didn't change **Dentist**. Ask again when Donnie is around.");
  assert.equal(timedOut.approval?.description, "Calla asked on Discord. Dentist, Wednesday October 14 at 10:00 AM, on the Family calendar.", "a new name only: no new time");
  const placeOnly = await call(s, "calendar_update", CALLA_ID, { event: wire("c1", event), location: "Main St" }, "deny");
  assert.equal(placeOnly.approval?.description, "Calla asked on Discord. Dentist, Wednesday October 14 at 10:00 AM, on the Family calendar.");
  const later = await call(s, "calendar_update", CALLA_ID, { event: wire("c1", event), start: "2026-10-15T14:00:00-03:00" }, "deny");
  assert.equal(later.approval?.description, "Calla asked on Discord. Dentist, Wednesday October 14 at 10:00 AM, on the Family calendar. It would move to Thursday October 15 at 2:00 PM.");
  assert.deepEqual(s.log.rows.map((row) => [row.op, row.status, row.eventId, JSON.parse(row.beforeJson ?? "{}").summary]), [
    ["delete", "denied", event.id, "Dentist"],
    ["update", "timed-out", event.id, "Dentist"],
    ["update", "denied", event.id, "Dentist"],
    ["update", "denied", event.id, "Dentist"],
  ]);
  const allowed = await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", event) });
  assert.equal(allowed.text, "Deleted **Dentist** from the Family calendar. It was Wednesday October 14 at 10:00 AM.");
  assert.ok(s.tools.get("calendar_delete")!(discord(CALLA_ID, "calendar_delete").tool).description.includes("That didn't get approved, so I didn't delete **<event name>**."));
});

test("the approval hook's read: a missing event blocks with the not-found line, a gog failure with the unreachable line", async () => {
  const s = setup();
  assert.deepEqual(await call(s, "calendar_delete", CALLA_ID, { event: "c1/nope" }), { blocked: NO_SUCH_EVENT });
  s.gog.fail.set("event", () => gogError("Error: googleapi: Error 500: Backend Error"));
  assert.deepEqual(await call(s, "calendar_delete", CALLA_ID, { event: "c1/nope" }), { blocked: "I couldn't reach the calendar just now, so I didn't delete that event. Try again in a bit." });
  assert.deepEqual(s.gog.writes(), []);
});

test("a stamp is bound to its tool: an update's stamp does not run a delete", async () => {
  const s = setup();
  const event = seed(s);
  const caller = discord(DONNIE_ID, "calendar_update");
  const params = { event: wire("c0", event) };
  const hooked = await s.hooks[0]!.handler({ toolName: "calendar_update", params: { ...params, title: "X" } }, caller.hook);
  const stamp = hooked?.params?.[STAMP_PARAM];
  assert.equal(typeof stamp, "string");
  const result = await s.tools.get("calendar_delete")!(caller.tool).execute("call-1", { ...params, [STAMP_PARAM]: stamp });
  assert.equal(result.content[0]!.text, "Something went wrong checking that, so I didn't delete that event.");
  assert.deepEqual(s.gog.writes(), []);
});

test("gog failures follow the op; the read-only error flips the grant and says so", async () => {
  const s = setup();
  const event = seed(s);
  s.gog.fail.set("delete", () => gogError("Error: googleapi: Error 500: Backend Error"));
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", event) }), { text: "I couldn't reach the calendar just now, so I didn't delete **Dentist**. Try again in a bit." });
  s.gog.fail.set("delete", () => gogError(READONLY_STDERR));
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", event) }), { text: READ_ONLY });
  assert.equal(s.grant.get(), "read-only");
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", event), title: "X" }), { blocked: READ_ONLY });
});

// ---- An event that changes while it waits for approval (arch, s5k.28) ----

const STALE = (verb: string, name = "Dentist") => `**${name}** was changed while it was waiting for approval, so I didn't ${verb} it. Ask again if you still want to.`;
const KIDS_CHANGES = [
  // Calla may not write the Family calendar, so each of these waits for a parent.
  { toolName: "calendar_update", op: "update", verb: "change", key: "c1", calendarId: FAMILY_CAL, params: { title: "Dentist (Calla)" } },
  { toolName: "calendar_move", op: "move", verb: "move", key: "c2", calendarId: CALLA_CAL, params: { calendar: "Family" } },
  { toolName: "calendar_delete", op: "delete", verb: "delete", key: "c1", calendarId: FAMILY_CAL, params: {} },
] as const;

test("gog bumps the etag between the approval and the tool: ux's line with the op's verb, a failed row with the event as it is now, no write", async () => {
  for (const change of KIDS_CHANGES) {
    const s = setup();
    const event = seed(s, { calendarId: change.calendarId });
    const outcome = await call(s, change.toolName, CALLA_ID, { event: wire(change.key, event), ...change.params }, "allow-once", {
      between: () => {
        event.etag = '"v7"';
        event.start = "2026-10-14T15:00:00.000Z";
        event.end = "2026-10-14T16:00:00.000Z";
      },
    });
    assert.ok(outcome.approval, change.toolName);
    assert.equal(outcome.text, STALE(change.verb));
    assert.deepEqual(s.gog.writes(), [], change.toolName);
    assert.deepEqual(
      s.log.rows.map((row) => [row.op, row.status, row.eventId, JSON.parse(row.beforeJson ?? "{}").start]),
      [[change.op, "failed", event.id, "2026-10-14T15:00:00.000Z"]],
      change.toolName,
    );
  }
});

test("an event renamed while it waited is named as the parent approved it, not as it is now", async () => {
  for (const change of KIDS_CHANGES) {
    const s = setup();
    const event = seed(s, { calendarId: change.calendarId });
    const outcome = await call(s, change.toolName, CALLA_ID, { event: wire(change.key, event), ...change.params }, "allow-once", {
      between: () => {
        event.summary = "Orthodontist";
        event.etag = '"v7"';
      },
    });
    assert.equal(outcome.text, STALE(change.verb));
    assert.equal(JSON.parse(s.log.rows[0]?.beforeJson ?? "{}").summary, "Orthodontist");
  }
});

test("nothing changed while it waited: the approved change is written once", async () => {
  for (const change of KIDS_CHANGES) {
    const s = setup();
    const event = seed(s, { calendarId: change.calendarId });
    const outcome = await call(s, change.toolName, CALLA_ID, { event: wire(change.key, event), ...change.params });
    assert.ok(outcome.approval && outcome.text && !outcome.text.includes("waiting for approval"), outcome.text);
    assert.equal(s.gog.writes().length, 1, change.toolName);
    assert.deepEqual(s.log.rows.map((row) => row.status), ["committed"]);
  }
});

test("the version is the etag, else the updated time; with neither, an approval is blocked and a direct write still goes", async () => {
  const s = setup();
  const a = seed(s, { calendarId: FAMILY_CAL, etag: undefined, updated: "2026-10-01T12:00:00.000Z" });
  const stale = await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", a) }, "allow-once", { between: () => (a.updated = "2026-10-02T12:00:00.000Z") });
  assert.equal(stale.text, STALE("delete"));
  const b = seed(s, { calendarId: FAMILY_CAL, etag: undefined });
  assert.deepEqual(await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", b) }), { blocked: "Something went wrong checking that, so I didn't delete **Dentist**." });
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c1", b) }), { text: "Deleted **Dentist** from the Family calendar. It was Wednesday October 14 at 10:00 AM." });
  assert.equal(s.gog.writes().length, 1);
});

test("the stamp's version and name are under its MAC: a swapped version, a swapped name or a bare MAC is refused, logged failed, and writes nothing", async () => {
  const s = setup();
  const event = seed(s, { calendarId: FAMILY_CAL });
  const caller = discord(CALLA_ID, "calendar_delete");
  const params = { event: wire("c1", event) };
  const hooked = await s.hooks[0]!.handler({ toolName: "calendar_delete", params: { ...params } }, caller.hook);
  const stamp = String(hooked?.params?.[STAMP_PARAM]);
  // The stamp is `<mac>.<base64url JSON [version, name]>`: the version travels in the clear.
  const [mac, carried] = stamp.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(carried ?? "", "base64url").toString("utf8")), ['"v1"', "Dentist"]);
  event.etag = '"v2"';
  const forged = (version: string, name: string) => `${mac}.${Buffer.from(JSON.stringify([version, name]), "utf8").toString("base64url")}`;
  for (const value of [forged('"v2"', "Dentist"), forged('"v1"', "Checkup"), mac]) {
    const result = await s.tools.get("calendar_delete")!(caller.tool).execute("call-1", { ...params, [STAMP_PARAM]: value });
    assert.equal(result.content[0]!.text, "Something went wrong checking that, so I didn't delete that event.");
  }
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows.map((row) => row.status), ["failed", "failed", "failed"]);
  // The untouched stamp still runs, and meets the newer version.
  const result = await s.tools.get("calendar_delete")!(caller.tool).execute("call-1", { ...params, [STAMP_PARAM]: stamp });
  assert.equal(result.content[0]!.text, STALE("delete"));
});

test("the version stays out of the key: the same approved change asked again answers from the log", async () => {
  const s = setup();
  const event = seed(s, { calendarId: FAMILY_CAL });
  const caller = discord(CALLA_ID, "calendar_update");
  const params = { event: wire("c1", event), title: "Dentist (Calla)" };
  const first = await call(s, "calendar_update", CALLA_ID, params, "allow-once", { caller });
  const again = await call(s, "calendar_update", CALLA_ID, params, "allow-once", { caller });
  assert.equal(first.text, "Changed **Dentist (Calla)** on the Family calendar. It's now Wednesday October 14 at 10:00 AM.");
  assert.equal(again.text, first.text);
  assert.equal(s.gog.writes().length, 1);
  assert.deepEqual(s.log.rows.map((row) => row.status), ["committed"]);
});

test("deleted while it waited: an update or move is not found by the approved name and logs nothing; a delete is done", async () => {
  for (const change of KIDS_CHANGES) {
    const s = setup();
    const event = seed(s, { calendarId: change.calendarId });
    const place = change.calendarId === FAMILY_CAL ? "the Family calendar" : "Calla's calendar";
    const outcome = await call(s, change.toolName, CALLA_ID, { event: wire(change.key, event), ...change.params }, "allow-once", {
      between: () => s.gog.events.splice(s.gog.events.indexOf(event), 1),
    });
    assert.equal(outcome.text, `I couldn't find **Dentist** on ${place}, so nothing changed.`, change.toolName);
    assert.deepEqual(s.log.rows, []);
  }
  for (const change of KIDS_CHANGES) {
    const s = setup();
    const event = seed(s, { calendarId: change.calendarId });
    const place = change.calendarId === FAMILY_CAL ? "the Family calendar" : "Calla's calendar";
    const outcome = await call(s, change.toolName, CALLA_ID, { event: wire(change.key, event), ...change.params }, "allow-once", {
      between: () => (event.status = "cancelled"),
    });
    if (change.op === "delete") {
      assert.equal(outcome.text, "Deleted **Dentist** from the Family calendar. It was Wednesday October 14 at 10:00 AM.");
      assert.deepEqual(s.log.rows.map((row) => [row.op, row.status]), [["delete", "committed"]]);
    } else {
      assert.equal(outcome.text, `I couldn't find **Dentist** on ${place}, so nothing changed.`, change.toolName);
      assert.deepEqual(s.log.rows, [], change.toolName);
    }
    assert.deepEqual(s.gog.writes(), []);
  }
});

// ---- Store failures (ux, s5k.28) ----

test("store failure before gog: ux's line with the op's verb, never the store's text, and no gog write", async () => {
  const s = setup();
  const event = seed(s);
  s.failAt.lookup = true;
  const outcomes = [
    await call(s, "calendar_create", DONNIE_ID, { calendar: "Donnie", title: "Sleepover", start: "2026-10-09T16:30:00-03:00", end: "2026-10-10T09:00:00-03:00" }),
    await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", event), title: "X" }),
    await call(s, "calendar_move", DONNIE_ID, { event: wire("c0", event), calendar: "Family" }),
    await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", event) }),
  ];
  assert.deepEqual(
    outcomes.map((outcome) => outcome.text),
    [
      "Something went wrong checking that, so I didn't add **Sleepover**.",
      "Something went wrong checking that, so I didn't change **Dentist**.",
      "Something went wrong checking that, so I didn't move **Dentist**.",
      "Something went wrong checking that, so I didn't delete **Dentist**.",
    ],
  );
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows.map((row) => [row.op, row.status]), [["create", "failed"], ["update", "failed"], ["move", "failed"], ["delete", "failed"]]);
  const page = await s.page(pageInput({ op: "delete", id: wire("c0", event) }), parentPage());
  assert.deepEqual(page, { ok: false, message: "Something went wrong checking that, so I didn't delete **Dentist**." });
});

test("no store at all: the same line, and the tool still answers instead of throwing", async () => {
  const s = setup({ noStore: true });
  const event = seed(s);
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", event) }), { text: "Something went wrong checking that, so I didn't delete that event." });
  assert.deepEqual(await call(s, "calendar_create", DONNIE_ID, { calendar: "Donnie", title: "Sleepover", start: "2026-10-09T16:30:00-03:00", end: "2026-10-10T09:00:00-03:00" }), {
    text: "Something went wrong checking that, so I didn't add **Sleepover**.",
  });
  assert.deepEqual(s.gog.writes(), []);
});

test("store failure after gog wrote: the normal success line and no warning", async () => {
  const s = setup();
  const a = seed(s);
  const b = seed(s);
  const c = seed(s);
  s.failAt.committed = true;
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", a), title: "Dentist (Calla)" }), { text: CHANGED });
  assert.deepEqual(await call(s, "calendar_move", DONNIE_ID, { event: wire("c0", b), calendar: "Family" }), { text: MOVED_FAMILY });
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: wire("c0", c) }), { text: DELETED });
  assert.equal(s.gog.writes().length, 3);
  assert.deepEqual(s.log.rows, []);
  const d = seed(s);
  assert.deepEqual(await s.page(pageInput({ op: "delete", id: wire("c0", d) }), parentPage()), { ok: true, message: DELETED });
});

test("an outcome row the store won't take leaves the parent's answer standing", async () => {
  const s = setup();
  const event = seed(s, { calendarId: FAMILY_CAL });
  s.failAt.any = true;
  assert.equal((await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", event) }, "deny")).blocked, "host:deny");
  const timedOut = await call(s, "calendar_create", CALLA_ID, { calendar: "Family", title: "Sleepover", start: "2026-10-09T16:30:00-03:00", end: "2026-10-10T09:00:00-03:00" }, "timeout");
  assert.equal(timedOut.blocked, "Nobody answered in 10 minutes, so I didn't add **Sleepover**. Ask again when Donnie is around.");
  assert.deepEqual(s.log.rows, []);
});

// ---- The page ----

let submits = 0;
function pageInput(input: Record<string, unknown>): CalendarWrite {
  submits += 1;
  return { requestId: `submit-${submits}`, ...input } as CalendarWrite;
}
function parentPage(scopes: string[] = ["operator.read", "operator.write"]): FeatureInvocationContext {
  return { source: "session-action", api: {}, action: { pluginId: "oc-family-pack", actionId: "family.calendar.write", payload: {}, client: { connId: "p", scopes } } } as unknown as FeatureInvocationContext;
}
function submit(s: Setup, input: CalendarWrite, context = parentPage()): Promise<PageWriteResult> {
  return s.page(input, context);
}

test("the page answers with ok and ux's line only, and tells open pages which calendars changed", async () => {
  const s = setup();
  const a = seed(s);
  const b = seed(s);
  const deleted = await submit(s, pageInput({ op: "delete", id: wire("c0", a) }));
  assert.deepEqual(deleted, { ok: true, message: DELETED });
  assert.deepEqual(Object.keys(deleted), ["ok", "message"]);
  assert.deepEqual(await submit(s, pageInput({ op: "move", id: wire("c0", b), destinationKey: "c1" })), { ok: true, message: MOVED_FAMILY });
  assert.deepEqual(await submit(s, pageInput({ op: "create", calendarKey: "c0", title: "Sleepover", start: "2026-10-09T19:30:00Z", end: "2026-10-10T12:00:00Z" })), {
    ok: true,
    message: "Added **Sleepover** to Donnie's calendar, Friday October 9 at 4:30 PM.",
  });
  assert.deepEqual(s.changed, [["c0"], ["c0", "c1"], ["c0"]]);
});

test("two page submits of the same change are two requests, and the second gets the same wording", async () => {
  const s = setup();
  const event = seed(s);
  const first = await submit(s, pageInput({ op: "update", id: wire("c0", event), title: "Dentist (Calla)" }));
  const second = await submit(s, pageInput({ op: "update", id: wire("c0", event), title: "Dentist (Calla)" }));
  assert.deepEqual([first, second], [{ ok: true, message: CHANGED }, { ok: true, message: CHANGED }]);
  assert.equal(s.log.rows.length, 2);
  assert.notEqual(s.log.rows[0]?.requestKey, s.log.rows[1]?.requestKey);
  assert.equal(s.gog.writes().length, 1);
});

test("the page gate: a guest is view-only, confirm mode gets the not-approved line with the op's verb, a bad requestId writes nothing", async () => {
  const s = setup();
  const event = seed(s);
  assert.deepEqual(await submit(s, pageInput({ op: "delete", id: wire("c0", event) }), parentPage(["operator.read"])), { ok: false, message: VIEW_ONLY });
  const confirm = setup({ writes: "confirm" });
  const held = seed(confirm);
  assert.deepEqual(await submit(confirm, pageInput({ op: "delete", id: wire("c0", held) })), {
    ok: false,
    message: "That didn't get approved, so I didn't delete **Dentist**. Ask again when Donnie is around.",
  });
  assert.deepEqual(await submit(s, { op: "delete", id: wire("c0", event), requestId: "a\nb" } as CalendarWrite), { ok: false, message: "Something went wrong checking that, so I didn't delete that event." });
  assert.deepEqual([s.gog.writes(), confirm.gog.writes(), s.log.rows], [[], [], []]);
});

test("ux's locked lines for a change that can't go ahead", async () => {
  assert.equal(NO_SUCH_EVENT, "I couldn't find that event, so nothing changed.");
  assert.equal(NOTHING_CHANGED, "I wasn't sure what to change, so I left it alone.");
  assert.equal(UNREADABLE_TIME, "I couldn't read that date or time, so nothing changed.");
  assert.equal(END_BEFORE_START_CHANGE, "The end has to be after the start. Nothing was changed.");
  const s = setup();
  const event = seed(s);
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", event) }), { blocked: NOTHING_CHANGED });
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", event), start: "next Tuesday-ish" }), { blocked: UNREADABLE_TIME });
  assert.deepEqual(await call(s, "calendar_update", DONNIE_ID, { event: wire("c0", event), start: "2026-10-14T12:00:00-03:00", end: "2026-10-14T11:00:00-03:00" }), { blocked: END_BEFORE_START_CHANGE });
  assert.deepEqual(await call(s, "calendar_move", DONNIE_ID, { event: wire("c0", event), calendar: "Grandma" }), { blocked: "I couldn't find a calendar called Grandma, so nothing changed." });
  assert.equal((await call(s, "calendar_update", CALLA_ID, { event: wire("c0", event), title: "X" }, "deny")).approval?.title, "Calla wants to change **Dentist** on Donnie's calendar");
  assert.equal((await call(s, "calendar_delete", CALLA_ID, { event: wire("c0", event) }, "deny")).approval?.title, "Calla wants to delete **Dentist** from Donnie's calendar");
  assert.deepEqual(await submit(s, pageInput({ op: "create", calendarKey: "c9", title: "Sleepover", start: "2026-10-09T19:30:00Z", end: "2026-10-10T12:00:00Z" })), {
    ok: false,
    message: "I couldn't find that calendar, so I didn't add **Sleepover**.",
  });
  assert.deepEqual(s.gog.writes(), []);
});

// ---- Review of 9044be8, points 1-5 ----

test("an empty version goes only with a direct write: an approved stamp without one is refused, logged failed, and writes nothing", async () => {
  const s = setup();
  const event = seed(s, { calendarId: FAMILY_CAL });
  const params = { event: wire("c1", event) };
  const stamper = createStamper();
  const kid = discord(CALLA_ID, "calendar_delete");
  const base = prepareChange(s.config, factsFromTool(kid.tool), "delete", params).base;
  const tool = calendarChangeTool("delete", s.deps, stamper, kid.tool);
  for (const stamp of [stamper.stamp(base, "approved", "calendar_delete"), stamper.stamp(base, "approved", "calendar_delete", { version: "", title: "Dentist" })]) {
    const result = await tool.execute("call-1", { ...params, [STAMP_PARAM]: stamp });
    assert.equal(result.content[0]!.text, "Something went wrong checking that, so I didn't delete that event.");
  }
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows.map((row) => row.status), ["failed", "failed"]);
  const parent = discord(DONNIE_ID, "calendar_delete");
  const direct = stamper.stamp(prepareChange(s.config, factsFromTool(parent.tool), "delete", params).base, "write", "calendar_delete");
  const done = await calendarChangeTool("delete", s.deps, stamper, parent.tool).execute("call-2", { ...params, [STAMP_PARAM]: direct });
  assert.equal(done.content[0]!.text, "Deleted **Dentist** from the Family calendar. It was Wednesday October 14 at 10:00 AM.");
  assert.equal(s.gog.writes().length, 1);
});

test("the tool's own gate checks a move's source and destination, each on its own", async () => {
  const s = setup();
  const context = {
    source: "tool",
    api: {},
    toolCallId: "call-1",
    tool: { sessionKey: "agent:main:discord:channel:gate", messageChannel: "discord", requesterSenderId: CALLA_ID, senderIsOwner: false },
  } as unknown as FeatureInvocationContext;
  const [, family, calla] = s.config.calendars;
  const hers = seed(s, { calendarId: CALLA_CAL });
  const shared = seed(s, { calendarId: FAMILY_CAL });
  const move = (from: typeof family, to: typeof family, eventId: string) =>
    submitChange({ config: s.config, runGog: s.gog.run, log: s.log, grant: s.grant }, { context, op: "move", calendar: from!, destination: to!, eventId });
  assert.equal((await move(calla, family, hers.id)).status, "needs-approval", "a destination Calla may not write");
  assert.equal((await move(family, calla, shared.id)).status, "needs-approval", "a source Calla may not write");
  assert.deepEqual(s.gog.writes(), []);
});

test("a series change stores the recurrence gog gave byte for byte, and reads it back", async () => {
  const s = setup();
  const recurrence = [
    "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z",
    "EXDATE;TZID=America/Halifax:20261020T180000,20261103T180000",
    "  rrule:freq=WEEKLY;Interval=1 ",
    "exdate;tzid=America/Halifax:20261117T180000",
  ];
  seed(s, { id: "swim", calendarId: CALLA_CAL, summary: "Swim", start: "2026-10-06T21:00:00.000Z", end: "2026-10-06T22:00:00.000Z", recurrence });
  seed(s, { id: "swim_13", calendarId: CALLA_CAL, summary: "Swim", start: "2026-10-13T21:00:00.000Z", end: "2026-10-13T22:00:00.000Z", recurringEventId: "swim", originalStart: "2026-10-13T21:00:00.000Z" });
  const caller = discord(DONNIE_ID, "calendar_delete");
  const first = await call(s, "calendar_delete", DONNIE_ID, { event: "c2/swim_13", scope: "all" }, "allow-once", { caller });
  assert.equal(first.text, "Deleted every **Swim** on Calla's calendar from Tuesday October 6 on.");
  const stored = s.log.rows[0]!.beforeJson!;
  assert.ok(stored.includes(`"recurrence":${JSON.stringify(recurrence)}`), stored);
  assert.equal(JSON.stringify(JSON.parse(stored).recurrence), JSON.stringify(recurrence));
  const again = await call(s, "calendar_delete", DONNIE_ID, { event: "c2/swim_13", scope: "all" }, "allow-once", { caller });
  assert.equal(again.text, first.text);
  assert.equal(s.gog.writes().length, 1);
});

test("a calendar named in the params is refused for update, move and delete; only the wire id's config key picks the calendar", async () => {
  const s = setup();
  const event = seed(s);
  const tools = [
    { toolName: "calendar_update", verb: "change", params: { title: "Dentist (Calla)" } },
    { toolName: "calendar_move", verb: "move", params: { calendar: "Calla" } },
    { toolName: "calendar_delete", verb: "delete", params: {} },
  ];
  for (const { toolName, verb, params } of tools) {
    const extras: Record<string, unknown>[] = [{ calendarId: FAMILY_CAL }, { calendarKey: "c1" }, ...(toolName === "calendar_move" ? [] : [{ calendar: "Family" }])];
    for (const extra of extras) {
      const outcome = await call(s, toolName, DONNIE_ID, { event: wire("c0", event), ...params, ...extra });
      assert.deepEqual(outcome, { blocked: `Something went wrong checking that, so I didn't ${verb} that event.` }, `${toolName} ${JSON.stringify(extra)}`);
    }
  }
  assert.deepEqual(await call(s, "calendar_delete", DONNIE_ID, { event: `${DONNIE_CAL}/${event.id}` }), { blocked: NO_SUCH_EVENT });
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows, []);
  assert.equal(event.calendarId, DONNIE_CAL);
});

test("no reply, approval or page answer carries a Google calendar id, an event id, a request key or a base key", async () => {
  const s = setup();
  const outputs: unknown[] = [];
  const ids: string[] = [];
  const event = (overrides: Partial<Event> = {}) => {
    const made = seed(s, { id: `evtQ7x${s.gog.events.length}`, ...overrides });
    ids.push(made.id);
    return made;
  };
  const tool = async (toolName: string, senderId: string, params: Record<string, unknown>, decide: ApprovalResolution = "allow-once", between?: () => void) => {
    const outcome = await call(s, toolName, senderId, params, decide, between ? { between } : {});
    outputs.push(outcome.text, outcome.blocked, outcome.approval?.title, outcome.approval?.description, outcome.approval?.timeoutReason);
  };
  const a = event();
  await tool("calendar_update", DONNIE_ID, { event: wire("c0", a), title: "Dentist (Calla)" });
  await tool("calendar_update", DONNIE_ID, { event: wire("c0", a), start: "2026-10-15T14:00:00-03:00" });
  await tool("calendar_move", DONNIE_ID, { event: wire("c0", event()), calendar: "Family" });
  await tool("calendar_delete", DONNIE_ID, { event: wire("c0", event()) });
  const shared = event({ calendarId: FAMILY_CAL });
  await tool("calendar_update", CALLA_ID, { event: wire("c1", shared), title: "Dentist (Calla)" }, "deny");
  await tool("calendar_move", CALLA_ID, { event: wire("c1", shared), calendar: "Calla" }, "timeout");
  await tool("calendar_delete", CALLA_ID, { event: wire("c1", shared) }, "allow-once", () => (shared.etag = '"v9"'));
  await tool("calendar_delete", DONNIE_ID, { event: "c0/evtQ7xMissing" });
  ids.push("evtQ7xMissing");
  outputs.push(await submit(s, pageInput({ op: "update", id: wire("c0", event()), title: "Dentist (Calla)" })));
  outputs.push(await submit(s, pageInput({ op: "move", id: wire("c0", event()), destinationKey: "c1" })));
  outputs.push(await submit(s, pageInput({ op: "delete", id: wire("c0", event()) })));
  const everything = JSON.stringify(outputs);
  assert.ok(s.log.rows.length >= 8, "the writes above logged their rows");
  for (const calendar of s.config.calendars) assert.ok(!everything.includes(calendar.id), calendar.id);
  for (const id of ids) assert.ok(!everything.includes(id), id);
  for (const row of s.log.rows) {
    assert.ok(!everything.includes(row.requestKey), "request key");
    assert.ok(!everything.includes(row.baseKey), "base key");
  }
  assert.ok(!/[0-9a-f]{32}/.test(everything), everything);
});

test("rrule, reminders and attendees are refused on every write tool and every page write", async () => {
  const s = setup();
  const event = seed(s);
  const extras: Record<string, unknown> = { rrule: "RRULE:FREQ=WEEKLY;BYDAY=TU", reminders: [{ method: "popup", minutes: 10 }], attendees: ["calla@example.com"] };
  const tools = [
    { toolName: "calendar_create", schema: CalendarCreateInputSchema, verb: "add", params: { calendar: "Donnie", title: "Sleepover", start: "2026-10-09T16:30:00-03:00", end: "2026-10-10T09:00:00-03:00" } },
    { toolName: "calendar_update", schema: CalendarUpdateInputSchema, verb: "change", params: { event: wire("c0", event), title: "Dentist (Calla)" } },
    { toolName: "calendar_move", schema: CalendarMoveInputSchema, verb: "move", params: { event: wire("c0", event), calendar: "Family" } },
    { toolName: "calendar_delete", schema: CalendarDeleteInputSchema, verb: "delete", params: { event: wire("c0", event) } },
  ];
  for (const { toolName, schema, verb, params } of tools) {
    assert.equal(Value.Check(schema, params), true, toolName);
    const caller = discord(DONNIE_ID, toolName);
    const stamped = await s.hooks[0]!.handler({ toolName, params: structuredClone(params) }, caller.hook);
    assert.equal(typeof stamped?.params?.[STAMP_PARAM], "string", toolName);
    for (const [field, value] of Object.entries(extras)) {
      const withField = { ...params, [field]: value };
      assert.equal(Value.Check(schema, withField), false, `${toolName} schema takes ${field}`);
      assert.deepEqual(await call(s, toolName, DONNIE_ID, withField), { blocked: `Something went wrong checking that, so I didn't ${verb} that event.` }, `${toolName} hook ${field}`);
      // tools.invoke runs the tool without the host's argument check, so the tool refuses too.
      const ran = await s.tools.get(toolName)!(caller.tool).execute("call-1", { ...withField, [STAMP_PARAM]: stamped!.params![STAMP_PARAM] });
      assert.equal(ran.content[0]!.text, `Something went wrong checking that, so I didn't ${verb} that event.`, `${toolName} tool ${field}`);
    }
  }
  const variants = [
    { op: "create", requestId: "r1", calendarKey: "c0", title: "Sleepover", start: "2026-10-09T19:30:00Z", end: "2026-10-10T12:00:00Z" },
    { op: "update", requestId: "r1", id: wire("c0", event), title: "Dentist (Calla)" },
    { op: "move", requestId: "r1", id: wire("c0", event), destinationKey: "c1" },
    { op: "delete", requestId: "r1", id: wire("c0", event) },
  ];
  for (const variant of variants) {
    assert.equal(Value.Check(CalendarWriteSchema, variant), true, variant.op);
    for (const [field, value] of Object.entries(extras)) assert.equal(Value.Check(CalendarWriteSchema, { ...variant, [field]: value }), false, `page ${variant.op} takes ${field}`);
  }
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows, []);
});

test("a title over 80 code points is capped at 80 in the stamp and in the waiting line, and the long-titled event still verifies", async () => {
  const s = setup();
  // Code points 79 and 80 are emoji, so a cut by UTF-16 units would split one.
  const long = `${"x".repeat(78)}🎉🎈 and the rest of a very long title`;
  const capped = `${"x".repeat(78)}🎉…`;
  const event = seed(s, { calendarId: FAMILY_CAL, summary: long });
  const caller = discord(CALLA_ID, "calendar_update");
  const tool = s.tools.get("calendar_update")!(caller.tool);
  const stampFor = async (description: string) => {
    const stamped = await s.hooks[0]!.handler({ toolName: "calendar_update", params: { event: wire("c1", event), description } }, caller.hook);
    return stamped!.params!;
  };
  const first = await stampFor("Bring cookies");
  const [, carried] = JSON.parse(Buffer.from(String(first[STAMP_PARAM]).split(".")[1]!, "base64url").toString("utf8")) as [string, string];
  assert.equal(carried, capped);
  assert.equal([...carried].length, 80);
  const done = await tool.execute("call-1", first);
  assert.equal(done.content[0]!.text, `Changed **${long}** on the Family calendar. It's now Wednesday October 14 at 10:00 AM.`);
  const second = await stampFor("Bring juice");
  event.etag = '"v9"';
  const stale = await tool.execute("call-2", second);
  assert.equal(stale.content[0]!.text, `**${capped}** was changed while it was waiting for approval, so I didn't change it. Ask again if you still want to.`);
  assert.equal(s.gog.writes().length, 1);
});

test("pageWrite refuses an extra field on every op by itself, without the host's schema check", async () => {
  const s = setup();
  const event = seed(s);
  const variants: { input: Record<string, unknown>; verb: string }[] = [
    { input: { op: "create", calendarKey: "c0", title: "Sleepover", start: "2026-10-09T19:30:00Z", end: "2026-10-10T12:00:00Z" }, verb: "add" },
    { input: { op: "update", id: wire("c0", event), title: "Dentist (Calla)" }, verb: "change" },
    { input: { op: "move", id: wire("c0", event), destinationKey: "c1" }, verb: "move" },
    { input: { op: "delete", id: wire("c0", event) }, verb: "delete" },
  ];
  const extras: Record<string, unknown> = { rrule: "RRULE:FREQ=WEEKLY", reminders: [{ method: "popup", minutes: 10 }], attendees: ["calla@example.com"], calendarId: FAMILY_CAL };
  for (const { input, verb } of variants) {
    for (const [field, value] of Object.entries(extras)) {
      const answer = await submit(s, pageInput({ ...input, [field]: value }));
      assert.deepEqual(answer, { ok: false, message: `Something went wrong checking that, so I didn't ${verb} that event.` }, `${String(input.op)} ${field}`);
    }
  }
  assert.deepEqual(s.gog.writes(), []);
  assert.deepEqual(s.log.rows, []);
});

test("an event already cancelled when we first look is not found, with no row, from the approval hook and from the page's direct delete", async () => {
  const s = setup();
  const shared = seed(s, { calendarId: FAMILY_CAL, status: "cancelled" });
  const mine = seed(s, { status: "cancelled" });
  assert.deepEqual(await call(s, "calendar_delete", CALLA_ID, { event: wire("c1", shared) }), { blocked: "I couldn't find **Dentist** on the Family calendar, so nothing changed." });
  assert.deepEqual(await submit(s, pageInput({ op: "delete", id: wire("c0", mine) })), { ok: false, message: "I couldn't find **Dentist** on Donnie's calendar, so nothing changed." });
  assert.deepEqual(s.log.rows, []);
  assert.deepEqual(s.gog.writes(), []);
});
