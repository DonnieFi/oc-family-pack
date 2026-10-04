import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DeliveryOutcome, DeliveryTarget, DiscordMessage } from "./discord-delivery.ts";
import type { Detail } from "./households.ts";
import { householdTick } from "./households.ts";
import type { FamilyStore } from "./store.ts";
import type { Config, ScheduleInput, ScheduleOutput } from "./types.ts";
import { localTime } from "./week.ts";

const DIST_STORE = new URL("../dist/store.js", import.meta.url);
type OpenStore = (options: { stateDir: string }) => Promise<FamilyStore>;
let openFamilyStore: OpenStore;
const dirs: string[] = [];
const stores: FamilyStore[] = [];
before(async () => {
  ({ openFamilyStore } = (await import(DIST_STORE.href)) as { openFamilyStore: OpenStore });
});
after(async () => {
  for (const store of stores) await store.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
async function freshStore(): Promise<FamilyStore> {
  const dir = mkdtempSync(join(tmpdir(), "ocfp-household-"));
  dirs.push(dir);
  const store = await openFamilyStore({ stateDir: dir });
  stores.push(store);
  return store;
}

const TZ = "America/Halifax";
const WED = "2026-10-14";
const FRI = "2026-10-16";
const at = (date: string, hours: number, minutes = 0) => localTime(date, hours, TZ) + minutes * 60_000;

const CONFIG: Config = {
  timezone: TZ,
  demo: false,
  gogPath: "gog",
  writes: "off",
  calendars: [{ key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] }],
  channels: { family: "222222222222222222" },
  summaryChannel: "family",
  morningTime: "07:00",
  afterSchoolTime: "15:30",
  weekendPreviewTime: "16:00",
  schoolHints: ["field trip"],
  closedDayPhrases: ["no school"],
  members: [
    { profileId: "alex", displayName: "Alex", role: "parent", discordId: "333333333333333333", devices: [] },
    { profileId: "sam", displayName: "Sam", role: "parent", discordId: "444444444444444444", devices: [] },
    { profileId: "riley", displayName: "Riley", role: "kid", discordId: "555555555555555555", devices: [] },
  ],
};

const SENT: DeliveryOutcome = { status: "sent", receipt: { messageIds: ["1"], sentAt: 1 } };
const FAILED: DeliveryOutcome = { status: "failed", errorKind: "no-channel", detail: "no discord id" };

type Call = { target: DeliveryTarget; key: string; description?: string };

function rig(
  store: FamilyStore,
  schedule: (input: ScheduleInput) => ScheduleOutput,
  details: Detail[],
  answer: (key: string) => DeliveryOutcome = () => SENT,
  config: Config = CONFIG,
) {
  const calls: Call[] = [];
  const asked: ScheduleInput[] = [];
  const deps = {
    config,
    store: () => store,
    deliver: async (target: DeliveryTarget, messages: readonly DiscordMessage[], key: string) => {
      const description = messages[0]?.embed?.description ?? messages[0]?.text;
      calls.push({ target, key, ...(description === undefined ? {} : { description }) });
      return answer(key);
    },
    schedule: async (input: ScheduleInput) => {
      asked.push(input);
      return schedule(input);
    },
    details: async () => details,
    log: () => {},
  };
  return { deps, calls, asked };
}

const dentist = {
  sections: [{ name: "not the usual" as const, items: [{ id: "c0/dentist", title: "Dentist", time: "9:00 AM", owners: ["Alex"] }] }],
};
const dentistDetail: Detail = { id: "c0/dentist", title: "Dentist", date: WED, allDay: false, minutes: 9 * 60, endMinutes: 9 * 60 + 30 };

test("morning posts once to each parent and a restart does not post again", async () => {
  const store = await freshStore();
  const { deps, calls, asked } = rig(store, () => dentist, [dentistDetail]);
  await householdTick(deps, at(WED, 7, 5));
  await householdTick(deps, at(WED, 7, 6));
  assert.deepEqual(asked[0], { start: WED, days: 2 });
  assert.deepEqual(
    calls.map((call) => call.key),
    [`household:morning:${WED}:alex`, `household:morning:${WED}:sam`],
  );
  assert.equal(calls[0]?.description, "Today 9:00 AM: Dentist (Alex)");
  assert.equal(calls.every((call) => "member" in call.target), true);
});

test("an empty morning and a usual after-school day produce no post", async () => {
  const store = await freshStore();
  const empty = rig(store, () => ({ note: "Nothing on the calendar." }), []);
  await householdTick(empty.deps, at(WED, 7));
  assert.equal(empty.calls.length, 0);
  const usual = rig(store, () => ({ sections: [], usual: "Usual: Soccer 4:00 PM" }), []);
  await householdTick(usual.deps, at(WED, 15, 30));
  assert.equal(usual.calls.length, 0);
});

test("after school posts the channel once, and a closed day posts nothing", async () => {
  const store = await freshStore();
  const game = {
    sections: [{ name: "not the usual" as const, items: [{ id: "c0/game", title: "Soccer game", time: "4:00 PM", owners: ["Riley"] }] }],
  };
  const detail: Detail = { id: "c0/game", title: "Soccer game", date: WED, allDay: false, minutes: 16 * 60 };
  const { deps, calls } = rig(store, () => game, [detail]);
  await householdTick(deps, at(WED, 15, 30));
  await householdTick(deps, at(WED, 15, 31));
  assert.deepEqual(calls.map((call) => call.key), [`household:after-school:${WED}`]);
  assert.equal("channel" in calls[0]!.target && calls[0]!.target.channel, "family");

  const closed = rig(store, () => game, [{ ...detail, title: "No school" }, detail]);
  await householdTick(closed.deps, at(WED, 15, 40));
  assert.equal(closed.calls.length, 0);
});

test("a quiet weekend posts one line to the channel", async () => {
  const store = await freshStore();
  const { morningTime: _morning, afterSchoolTime: _afternoon, ...weekendOnly } = CONFIG;
  const { deps, calls, asked } = rig(store, () => ({ note: "Nothing on the calendar." }), [], () => SENT, weekendOnly);
  await householdTick(deps, at(FRI, 16));
  await householdTick(deps, at(FRI, 16, 1));
  assert.deepEqual(asked[0], { start: FRI, days: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.description, "Quiet weekend: nothing major on the calendar.");
});

test("a failed after-school post is recorded and each parent is told once", async () => {
  const store = await freshStore();
  const game = {
    sections: [{ name: "not the usual" as const, items: [{ id: "c0/game", title: "Soccer game", time: "4:00 PM", owners: ["Riley"] }] }],
  };
  const detail: Detail = { id: "c0/game", title: "Soccer game", date: WED, allDay: false, minutes: 16 * 60 };
  const { deps, calls } = rig(store, () => game, [detail], (key) => (key.startsWith("alert:") ? SENT : FAILED));
  await householdTick(deps, at(WED, 15, 30));
  await householdTick(deps, at(WED, 15, 31));
  const alerts = calls.filter((call) => call.key.startsWith("alert:"));
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((call) => ("member" in call.target ? call.target.member : "")).sort(),
    ["alex", "sam"],
  );
  assert.match(alerts[0]?.description ?? "", /after-school brief/);
  const posts = calls.filter((call) => call.key === `household:after-school:${WED}`);
  assert.equal(posts.length, 2);
});

test("a calendar read that fails logs nothing", async () => {
  const store = await freshStore();
  const { deps, calls } = rig(store, () => ({ error: "Calendar unavailable." }) satisfies ScheduleOutput, []);
  await householdTick(deps, at(WED, 7));
  assert.equal(calls.length, 0);
});
