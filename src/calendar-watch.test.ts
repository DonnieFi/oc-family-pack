import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunGog } from "./calendar-gog.ts";
import { MAX_WAIT_MS, POLL_MS, watchCalendars, type Schedule } from "./calendar-watch.ts";
import { parseConfig } from "./config.ts";
import { grantHolder, type GrantHolder } from "./grant.ts";

type Reply = { events: { id: string; updated: string; status?: string }[]; since: string } | Error | string;

function config(calendars: string[], demo = false) {
  return parseConfig({
    timezone: "America/Toronto",
    demo,
    gogPath: "/fake/gog",
    members: [{ profileId: "kid", displayName: "Kid", role: "kid" }],
    calendars: calendars.map((id) => ({ id, label: id, kind: "personal", owners: ["kid"] })),
  });
}

/** One queued gog answer per calendar per poll, plus a hand-run timer. */
function harness(calendars: string[], options: { demo?: boolean; emitThrows?: boolean; grant?: GrantHolder } = {}) {
  const replies = new Map<string, Reply[]>();
  const calls: string[][] = [];
  const emitted: [string, unknown][] = [];
  const warnings: string[] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const runGog: RunGog = async (_file, args) => {
    calls.push(args);
    const reply = replies.get(args.at(-1) ?? "")?.shift();
    if (reply === undefined) throw new Error(`no reply queued for ${args.at(-1)}`);
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === "string" ? reply : JSON.stringify(reply) };
  };
  const schedule: Schedule = (run, ms) => {
    const timer = { run, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const events = {
    emit(event: string, payload: unknown) {
      if (options.emitThrows) throw new Error("Feature event emitter is unavailable until its Gateway service starts");
      emitted.push([event, payload]);
    },
  };
  const queue = (id: string, ...answers: Reply[]) => replies.set(id, [...(replies.get(id) ?? []), ...answers]);
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const start = () =>
    watchCalendars({
      config: config(calendars, options.demo),
      runGog,
      events: events as never,
      logger: { warn: (message: string) => warnings.push(message) },
      schedule,
      ...(options.grant ? { grant: options.grant } : {}),
    });
  /** Fires the pending timer and waits for that poll to finish. */
  const tick = async () => {
    const timer = timers.at(-1);
    assert.ok(timer && !timer.cancelled, "a poll should be scheduled");
    timer.run();
    await settle();
  };
  const names = () => emitted.map(([event]) => event);
  return { queue, calls, emitted, names, warnings, timers, start, tick, settle };
}

const T0 = "2026-10-03T14:00:00.000Z";
const SINCE = "2026-09-03T14:00:00Z";
const one = (updated: string, id = "e1", status = "confirmed") => ({ events: [{ id, updated, status }], since: SINCE });

test("the start-up read records a baseline without awaiting, emits nothing, and asks gog for one calendar", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0));
  const stop = h.start();
  assert.equal(typeof stop, "function");
  await h.settle();
  assert.deepEqual(h.calls, [["calendar", "changed", "--since", "720h", "--max", "1", "--json", "--no-input", "--", "cal-a"]]);
  assert.deepEqual(h.emitted, []);
  assert.equal(h.timers.at(-1)?.ms, POLL_MS);
  assert.equal(POLL_MS, 3 * 60_000);
});

test("an event updated after the baseline sends calendar-changed, then calendar-checked", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0), one("2026-10-03T14:02:00.250Z"));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.calls[1]?.slice(2, 4), ["--since", T0]);
  assert.deepEqual(h.names(), ["calendar-changed", "calendar-checked"]);
  const [, changed] = h.emitted[0] ?? [];
  assert.deepEqual({ ...(changed as object), at: "x" }, { reason: "external", calendarKeys: [], at: "x" });
  assert.ok(Number.isFinite(Date.parse((changed as { at: string }).at)));
  assert.deepEqual(h.emitted[1]?.[1], {});
});

test("the boundary event coming back on every poll is not a change", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0), one(T0), one(T0));
  h.start();
  await h.settle();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-checked", "calendar-checked"]);
});

test("a deletion is a change", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0), one("2026-10-03T14:05:00.000Z", "e1", "cancelled"));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-changed", "calendar-checked"]);
});

test("an empty poll keeps gog's since, and the first event after it is a change", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", { events: [], since: SINCE }, { events: [], since: SINCE }, one(T0));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.calls[1]?.slice(2, 4), ["--since", SINCE]);
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-checked", "calendar-changed", "calendar-checked"]);
});

test("an edit with milliseconds after a fractionless mark from gog's since is a change", async () => {
  const h = harness(["cal-a"]);
  // gog's since has no fraction, and "." sorts before "Z", so only a time compare sees the edit as newer.
  h.queue("cal-a", { events: [], since: "2026-10-03T14:00:00Z" }, one("2026-10-03T14:00:00.123Z"));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-changed", "calendar-checked"]);
});

test("a failed poll sends nothing and doubles the wait up to 30 minutes; a success resets it", async () => {
  const h = harness(["cal-a"]);
  const down = Object.assign(new Error("Command failed"), { code: 1, stderr: "boom" });
  h.queue("cal-a", one(T0), down, down, down, down, down, one(T0));
  h.start();
  await h.settle();
  const waits: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    await h.tick();
    waits.push(h.timers.at(-1)?.ms ?? 0);
  }
  assert.deepEqual(waits, [6, 12, 24, 30, 30, 3].map((minutes) => minutes * 60_000));
  assert.equal(MAX_WAIT_MS, 30 * 60_000);
  assert.deepEqual(h.names(), ["calendar-checked"]);
  assert.ok(h.warnings.every((warning) => !warning.includes("boom")), "stderr is never copied into the log");
});

test("unreadable gog output is a failed poll", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0), "not json", JSON.stringify({ since: SINCE }));
  h.start();
  await h.settle();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.emitted, []);
  assert.equal(h.timers.at(-1)?.ms, 4 * POLL_MS);
});

test("one calendar failing still sends a change seen on another, but no calendar-checked", async () => {
  const h = harness(["cal-a", "cal-b"]);
  h.queue("cal-a", one(T0), one("2026-10-03T14:09:00.000Z"));
  h.queue("cal-b", one(T0), new Error("Command failed"));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-changed"]);
  assert.equal(h.timers.at(-1)?.ms, 2 * POLL_MS);
});

test("a calendar whose start-up read failed gets its baseline on its next success and emits nothing for it", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", new Error("Command failed"), one(T0), one(T0));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-checked"]);
  await h.tick();
  assert.deepEqual(h.names(), ["calendar-checked", "calendar-checked"]);
});

test("the newest updated wins regardless of order", async () => {
  const h = harness(["cal-a"]);
  const later = "2026-10-03T14:10:00.000Z";
  h.queue("cal-a", { events: [{ id: "a", updated: T0 }, { id: "b", updated: later }], since: SINCE }, one(later, "b"));
  h.start();
  await h.settle();
  await h.tick();
  assert.deepEqual(h.calls[1]?.slice(2, 4), ["--since", later]);
  assert.deepEqual(h.names(), ["calendar-checked"]);
});

test("stop cancels the timer, and a poll that finishes after stop sends and schedules nothing", async () => {
  const h = harness(["cal-a"]);
  h.queue("cal-a", one(T0), one("2026-10-03T14:11:00.000Z"));
  const stop = h.start();
  await h.settle();
  const pending = h.timers.at(-1);
  pending?.run();
  stop();
  await h.settle();
  assert.deepEqual(h.emitted, []);
  assert.equal(h.timers.length, 1);
  const again = harness(["cal-a"]);
  again.queue("cal-a", one(T0));
  again.start()();
  await again.settle();
  assert.equal(again.timers.length, 0);
});

test("an emit that throws is logged and polling carries on", async () => {
  const h = harness(["cal-a"], { emitThrows: true });
  h.queue("cal-a", one(T0), one("2026-10-03T14:12:00.000Z"));
  h.start();
  await h.settle();
  await h.tick();
  assert.equal(h.warnings.length, 2);
  assert.equal(h.timers.at(-1)?.ms, POLL_MS);
});

test("demo mode and an empty roster never call gog", async () => {
  for (const h of [harness([], {}), harness(["cal-a"], { demo: true })]) {
    h.start()();
    await h.settle();
    assert.deepEqual(h.calls, []);
    assert.equal(h.timers.length, 0);
  }
});

const AUTH_LIST = "--no-input";
const account = (scopes: string[]) => JSON.stringify({ accounts: [{ email: "person@example.com", services: ["calendar"], scopes }] });
const READ_WRITE_ACCOUNT = account(["https://www.googleapis.com/auth/calendar", "openid"]);
const READ_ONLY_ACCOUNT = account(["https://www.googleapis.com/auth/calendar.readonly", "openid"]);

test("each poll re-reads gog's grant: read-only sets it, read-write clears it, and a failed or unclear read leaves it", async () => {
  const grant = grantHolder();
  const h = harness(["cal-a"], { grant });
  h.queue("cal-a", one(T0), one(T0), one(T0), one(T0), one(T0));
  h.queue(AUTH_LIST, READ_ONLY_ACCOUNT, READ_WRITE_ACCOUNT, new Error("gog timed out"), JSON.stringify({ accounts: [] }), READ_ONLY_ACCOUNT);
  h.start();
  await h.settle();
  assert.deepEqual(h.calls[0], ["calendar", "changed", "--since", "720h", "--max", "1", "--json", "--no-input", "--", "cal-a"]);
  assert.deepEqual(h.calls[1], ["auth", "list", "--json", "--no-input"]);
  assert.equal(grant.get(), "read-only");
  await h.tick();
  assert.equal(grant.get(), "read-write");
  await h.tick();
  assert.equal(grant.get(), "read-write");
  await h.tick();
  assert.equal(grant.get(), "read-write");
  await h.tick();
  assert.equal(grant.get(), "read-only");
});

test("a poll that sees read-write clears a read-only status a failed write set", async () => {
  const grant = grantHolder();
  grant.noteWriteFailure(Object.assign(new Error("Command failed"), { stderr: "Error 403: Request had insufficient authentication scopes." }));
  assert.equal(grant.get(), "read-only");
  const h = harness(["cal-a"], { grant });
  h.queue("cal-a", one(T0));
  h.queue(AUTH_LIST, READ_WRITE_ACCOUNT);
  h.start();
  await h.settle();
  assert.equal(grant.get(), "read-write");
});
