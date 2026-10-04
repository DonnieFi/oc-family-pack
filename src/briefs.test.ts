import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { briefTick, dueBriefs, type BriefDeps } from "./briefs.ts";
import type { DeliveryOutcome, DeliveryTarget, DiscordMessage } from "./discord-delivery.ts";
import type { FamilyStore } from "./store.ts";
import type { Config } from "./types.ts";
import { localTime } from "./week.ts";

// The built store, as production loads it (see store.test.ts).
const DIST_STORE = new URL("../dist/store.js", import.meta.url);
type OpenStore = (options: { stateDir: string }) => Promise<FamilyStore>;
let openFamilyStore: OpenStore;
const dirs: string[] = [];
const stores: FamilyStore[] = [];
const paths = new Map<FamilyStore, string>();
before(async () => {
  ({ openFamilyStore } = (await import(DIST_STORE.href)) as { openFamilyStore: OpenStore });
});
after(async () => {
  for (const store of stores) await store.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
async function freshStore(): Promise<FamilyStore> {
  const dir = mkdtempSync(join(tmpdir(), "ocfp-briefs-"));
  dirs.push(dir);
  const store = await openFamilyStore({ stateDir: dir });
  stores.push(store);
  paths.set(store, join(dir, "plugins", "oc-family-pack", "oc-family-pack.sqlite"));
  return store;
}

const TZ = "America/Halifax";
const at = (date: string, hours: number) => localTime(date, hours, TZ);
const CONFIG: Config = {
  timezone: TZ,
  demo: false,
  gogPath: "gog",
  writes: "off",
  calendars: [],
  channels: { family: "222222222222222222" },
  summaryChannel: "family",
  members: [
    { profileId: "alex", displayName: "Alex", role: "parent", discordId: "333333333333333333", devices: [] },
    { profileId: "sam", displayName: "Sam", role: "parent", discordId: "444444444444444444", devices: [] },
    { profileId: "riley", displayName: "Riley", role: "kid", discordId: "555555555555555555", devices: [] },
  ],
};

type Call = { target: DeliveryTarget; messages: readonly DiscordMessage[]; key: string };
type Answer = (key: string) => DeliveryOutcome;
const SENT: DeliveryOutcome = { status: "sent", receipt: { messageIds: ["1"], sentAt: 1 } };
const HELD: DeliveryOutcome = { status: "held", errorKind: "other", detail: "network ECONNREFUSED; sentBeforeError false; queueCustody held" };
const UNKNOWN: DeliveryOutcome = { status: "unknown", errorKind: "no-permission", detail: "Discord HTTP 403 code 50013; sentBeforeError true; queueCustody held" };

/**
 * A host that keeps every key it has seen, as the real one does inside its retention: a second send of
 * a key comes back claimed. `answer` decides the first send.
 */
function rig(store: FamilyStore, answer: Answer = () => SENT, overrides: Partial<BriefDeps> = {}) {
  const calls: Call[] = [];
  const seen = new Set<string>();
  const logs: string[] = [];
  const deps: BriefDeps = {
    config: CONFIG,
    store: () => store,
    deliver: async (target, messages, key) => {
      calls.push({ target, messages, key });
      if (seen.has(key)) return { status: "claimed" };
      const outcome = answer(key);
      // Our own pre-send check fails before the host sees the key.
      if (outcome.status !== "failed") seen.add(key);
      return outcome;
    },
    agentName: async () => "Hazel",
    readCalendars: async () => ({ status: "ok", data: [], warnings: [] }),
    readWeather: async () => undefined,
    garbageTomorrow: async () => undefined,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, calls, logs, seen };
}

type Row = { delivery_key: string; kind: string; target: string; status: string; error_kind: string | null };
async function rows(store: FamilyStore): Promise<Row[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.get(store)!, { readOnly: true });
  try {
    return db.prepare("SELECT delivery_key, kind, target, status, error_kind FROM oc_family_pack_delivery_log ORDER BY id").all().map((row) => ({ ...row }) as Row);
  } finally {
    db.close();
  }
}

test("windows: daily 07:00 to 12:00 on its date; weekly Sunday 20:00 to Monday 12:00 across the DST change", () => {
  const keys = (instant: number) => dueBriefs(instant, TZ).map((brief) => brief.key);
  assert.deepEqual(keys(at("2026-10-13", 6.99)), []);
  assert.deepEqual(keys(at("2026-10-13", 7)), ["daily-summary:2026-10-13"]);
  assert.deepEqual(keys(at("2026-10-13", 11 + 59 / 60)), ["daily-summary:2026-10-13"]);
  assert.deepEqual(keys(at("2026-10-13", 12)), []);
  assert.deepEqual(keys(at("2026-11-01", 19 + 59 / 60)), []);
  // Sunday Nov 1 20:00 AST is Monday 00:00 UTC; the covered week is keyed by its Monday.
  assert.equal(at("2026-11-01", 20), Date.parse("2026-11-02T00:00:00Z"));
  assert.deepEqual(keys(at("2026-11-01", 20)), ["weekly-summary:2026-11-02"]);
  assert.deepEqual(keys(Date.parse("2026-11-02T15:59:00Z")), ["daily-summary:2026-11-02", "weekly-summary:2026-11-02"]);
  assert.deepEqual(keys(Date.parse("2026-11-02T16:01:00Z")), []);
  assert.deepEqual(keys(at("2026-11-03", 9)), ["daily-summary:2026-11-03"]);
  assert.deepEqual(keys(at("2026-11-08", 6)), []);
  // A Monday restart before noon still owes the week ahead.
  assert.deepEqual(keys(at("2026-10-12", 7)), ["daily-summary:2026-10-12", "weekly-summary:2026-10-12"]);
});

test("daily: a restart at 07:40 sends once, and the brief carries the agent name", async () => {
  const store = await freshStore();
  const first = rig(store);
  await briefTick(first.deps, at("2026-10-13", 7 + 40 / 60));
  const restarted = rig(store);
  await briefTick(restarted.deps, at("2026-10-13", 7 + 41 / 60));
  assert.deepEqual(first.calls.map((call) => call.key), ["daily-summary:2026-10-13"]);
  assert.deepEqual(first.calls[0]!.target, { channel: "family" });
  assert.equal(first.calls[0]!.messages[0]!.embed!.footer!.text, "Chat with Hazel anytime to manage events");
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(await rows(store), [{ delivery_key: "daily-summary:2026-10-13", kind: "daily", target: "family", status: "sent", error_kind: null }]);
});

test("daily: 11:59 sends, 12:01 does not, and the next morning never sends yesterday's", async () => {
  const late = rig(await freshStore());
  await briefTick(late.deps, at("2026-10-13", 11 + 59 / 60));
  assert.deepEqual(late.calls.map((call) => call.key), ["daily-summary:2026-10-13"]);
  const store = await freshStore();
  const missed = rig(store);
  await briefTick(missed.deps, at("2026-10-13", 12 + 1 / 60));
  assert.equal(missed.calls.length, 0);
  await briefTick(missed.deps, at("2026-10-14", 7));
  assert.deepEqual(missed.calls.map((call) => call.key), ["daily-summary:2026-10-14"]);
  assert.deepEqual((await rows(store)).map((row) => row.delivery_key), ["daily-summary:2026-10-14"]);
});

test("weekly across the Nov 1 2026 DST change: sends at Monday 11:59 AST, not at 12:01", async () => {
  const on = rig(await freshStore());
  await briefTick(on.deps, Date.parse("2026-11-02T15:59:00Z"));
  const weekly = on.calls.find((call) => call.key === "weekly-summary:2026-11-02");
  assert.ok(weekly);
  assert.equal(weekly.messages[0]!.embed!.title, "📅 Week Ahead — November 02 to November 08");
  const off = rig(await freshStore());
  await briefTick(off.deps, Date.parse("2026-11-02T16:01:00Z"));
  assert.equal(off.calls.length, 0);
});

test("held is final: never resent, never relogged, and both parents get one alert each with their own key", async () => {
  const store = await freshStore();
  const { deps, calls } = rig(store, (key) => (key.startsWith("daily-summary:") ? HELD : SENT));
  await briefTick(deps, at("2026-10-13", 7));
  await briefTick(deps, at("2026-10-13", 7 + 1 / 60));
  await briefTick(deps, at("2026-10-13", 9));
  const log = await rows(store);
  const briefRows = log.filter((row) => row.kind === "daily");
  assert.deepEqual(briefRows, [{ delivery_key: "daily-summary:2026-10-13", kind: "daily", target: "family", status: "held", error_kind: "other" }]);
  assert.equal(calls.filter((call) => call.key === "daily-summary:2026-10-13").length, 1);
  const alerts = log.filter((row) => row.kind === "alert");
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((row) => [row.target, row.status]), [["alex", "sent"], ["sam", "sent"]]);
  const streakId = (await store.deliveryStreakStart("daily", "family"))!.id;
  assert.deepEqual(alerts.map((row) => row.delivery_key), [`alert:daily:family:${streakId}:alex`, `alert:daily:family:${streakId}:sam`]);
  const alertCalls = calls.filter((call) => call.key.startsWith("alert:"));
  assert.deepEqual(alertCalls.map((call) => call.target), [{ member: "alex" }, { member: "sam" }]);
  assert.ok(alertCalls.every((call) => typeof call.messages[0]!.text === "string" && call.messages[0]!.embed === undefined));
});

test("one alert per streak: a second bad day in the same streak alerts nobody; a sent day ends the streak", async () => {
  const store = await freshStore();
  let brief: DeliveryOutcome = UNKNOWN;
  const { deps, calls } = rig(store, (key) => (key.startsWith("alert:") ? SENT : brief));
  await briefTick(deps, at("2026-10-13", 7));
  await briefTick(deps, at("2026-10-14", 7));
  assert.equal(calls.filter((call) => call.key.startsWith("alert:")).length, 2);
  brief = SENT;
  await briefTick(deps, at("2026-10-15", 7));
  brief = HELD;
  await briefTick(deps, at("2026-10-16", 7));
  const alertKeys = calls.filter((call) => call.key.startsWith("alert:")).map((call) => call.key);
  assert.equal(alertKeys.length, 4);
  assert.equal(new Set(alertKeys.map((key) => key.split(":")[3])).size, 2, "two streaks");
  assert.deepEqual((await rows(store)).filter((row) => row.kind === "daily").map((row) => row.status), ["unknown", "unknown", "sent", "held"]);
});

test("alert rows never raise alerts, even when the alert itself fails", async () => {
  const store = await freshStore();
  const { deps, calls } = rig(store, (key) => (key.startsWith("alert:") ? UNKNOWN : HELD));
  await briefTick(deps, at("2026-10-13", 7));
  await briefTick(deps, at("2026-10-13", 8));
  assert.deepEqual(calls.map((call) => call.key.split(":").slice(0, 2).join(":")), ["daily-summary:2026-10-13", "alert:daily", "alert:daily"]);
  assert.equal(await store.deliveryStreakStart("alert", "alex").then((row) => row?.status), "unknown");
  assert.ok(calls.every((call) => !call.key.startsWith("alert:alert")));
});

test("claimed logs unknown and is final", async () => {
  const store = await freshStore();
  const { deps, calls, seen } = rig(store);
  seen.add("daily-summary:2026-10-13");
  await briefTick(deps, at("2026-10-13", 7));
  await briefTick(deps, at("2026-10-13", 8));
  assert.equal(calls.filter((call) => call.key.startsWith("daily-summary:")).length, 1);
  assert.deepEqual((await rows(store))[0], { delivery_key: "daily-summary:2026-10-13", kind: "daily", target: "family", status: "unknown", error_kind: "other" });
});

test("failed (our own pre-send check) is tried again on the next tick in the window, alerting once", async () => {
  const store = await freshStore();
  let missing = true;
  const { deps, calls } = rig(store, (key) =>
    key.startsWith("daily-summary:") && missing ? { status: "failed", errorKind: "no-channel", detail: "no Discord id for this target in config" } : SENT,
  );
  await briefTick(deps, at("2026-10-13", 7));
  await briefTick(deps, at("2026-10-13", 7 + 1 / 60));
  missing = false;
  await briefTick(deps, at("2026-10-13", 7 + 2 / 60));
  await briefTick(deps, at("2026-10-13", 7 + 3 / 60));
  const daily = (await rows(store)).filter((row) => row.kind === "daily");
  assert.deepEqual(daily.map((row) => [row.status, row.error_kind]), [["failed", "no-channel"], ["failed", "no-channel"], ["sent", null]]);
  assert.equal(calls.filter((call) => call.key === "daily-summary:2026-10-13").length, 3);
  assert.equal(calls.filter((call) => call.key.startsWith("alert:")).length, 2);
});

test("a calendar read that fails logs nothing and waits for the next tick; weather and garbage failures only drop their lines", async () => {
  const store = await freshStore();
  let calendarUp = false;
  const { deps, calls, logs } = rig(store, () => SENT, {
    readCalendars: async () => (calendarUp ? { status: "ok", data: [], warnings: [] } : { status: "error", message: "gog failed" }),
    readWeather: async () => {
      throw new Error("weather down");
    },
    garbageTomorrow: async () => {
      throw new Error("garbage down");
    },
  });
  await briefTick(deps, at("2026-10-13", 7));
  assert.equal(calls.length, 0);
  assert.deepEqual(await rows(store), []);
  assert.match(logs[0]!, /calendar read failed/);
  calendarUp = true;
  await briefTick(deps, at("2026-10-13", 7 + 1 / 60));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.messages[0]!.embed!.description, undefined);
});

test("no summary channel or no store: the tick does nothing", async () => {
  const store = await freshStore();
  const { summaryChannel: _off, ...unset } = CONFIG;
  const none = rig(store, () => SENT, { config: unset });
  await briefTick(none.deps, at("2026-10-13", 7));
  const early = rig(store, () => SENT, { store: () => undefined });
  await briefTick(early.deps, at("2026-10-13", 7));
  assert.equal(none.calls.length + early.calls.length, 0);
});
