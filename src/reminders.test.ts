import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DeliveryOutcome, DeliveryTarget, DiscordMessage } from "./discord-delivery.ts";
import { reminderTick, setReminderMode } from "./reminders.ts";
import type { ReadEvent } from "./schedule.ts";
import type { FamilyStore } from "./store.ts";
import type { Config } from "./types.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "ocfp-reminders-"));
  dirs.push(dir);
  const store = await openFamilyStore({ stateDir: dir });
  stores.push(store);
  return store;
}

const TZ = "America/Halifax";
const at = (date: string, hours: number) => localTime(date, hours, TZ);
const CONFIG: Config = {
  timezone: TZ,
  demo: false,
  gogPath: "gog",
  writes: "off",
  calendars: [{ key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex", "riley"] }],
  channels: { family: "222222222222222222" },
  summaryChannel: "family",
  reminderLeadMinutes: [15],
  quietHours: { startHour: 22, endHour: 7 },
  members: [
    { profileId: "alex", displayName: "Alex", role: "parent", discordId: "333333333333333333", devices: [], reminders: "dm" },
    { profileId: "sam", displayName: "Sam", role: "parent", discordId: "444444444444444444", devices: [], reminders: "dm" },
    { profileId: "riley", displayName: "Riley", role: "kid", discordId: "555555555555555555", devices: [], reminders: "channel" },
    { profileId: "jordan", displayName: "Jordan", role: "kid", devices: [], reminders: "off" },
  ],
};

const START = new Date(at("2026-10-14", 10)).toISOString();
const EVENT: ReadEvent = {
  id: "c0/evt-1",
  title: "Dentist",
  start: START,
  end: new Date(Date.parse(START) + 30 * 60_000).toISOString(),
  allDay: false,
  calendarKey: "c0",
  google: { eventId: "evt-1", updated: "2026-10-01T12:00:00.000Z" },
};

type Call = { target: DeliveryTarget; key: string; text?: string };
const SENT: DeliveryOutcome = { status: "sent", receipt: { messageIds: ["1"], sentAt: 1 } };

function rig(store: FamilyStore, answer: (key: string) => DeliveryOutcome = () => SENT) {
  const calls: Call[] = [];
  const deps = {
    config: CONFIG,
    store: () => store,
    deliver: async (target: DeliveryTarget, messages: readonly DiscordMessage[], key: string) => {
      calls.push({ target, key, ...(messages[0]?.text ? { text: messages[0].text } : {}) });
      return answer(key);
    },
    readCalendars: async () => ({ status: "ok" as const, data: [EVENT], warnings: [] }),
    log: () => {},
  };
  return { deps, calls };
}

test("one reminder per owner, and a restart does not send it again", async () => {
  const store = await freshStore();
  const first = rig(store);
  await reminderTick(first.deps, at("2026-10-14", 9.75));
  const restarted = rig(store);
  await reminderTick(restarted.deps, at("2026-10-14", 9.76));
  assert.deepEqual(
    first.calls.map((call) => [call.key, call.target]),
    [
      [`reminder:c0/evt-1:15:${EVENT.google!.updated}:alex`, { member: "alex" }],
      [`reminder:c0/evt-1:15:${EVENT.google!.updated}:riley`, { channel: "family" }],
    ],
  );
  assert.equal(first.calls[1]!.text, "<@555555555555555555> — heads up!");
  assert.equal(restarted.calls.length, 0);
  assert.equal(first.calls.some((call) => call.key.includes("jordan")), false);
});

test("a quiet-hours reminder is delivered at the end of the window and not before", async () => {
  const store = await freshStore();
  const earlyStart = new Date(at("2026-10-14", 7.25)).toISOString();
  const early: ReadEvent = { ...EVENT, start: earlyStart, end: new Date(Date.parse(earlyStart) + 30 * 60_000).toISOString() };
  const held = rig(store);
  held.deps.config = { ...CONFIG, reminderLeadMinutes: [30] };
  held.deps.readCalendars = async () => ({ status: "ok", data: [early], warnings: [] });
  await reminderTick(held.deps, at("2026-10-14", 6.75));
  assert.equal(held.calls.length, 0);
  await reminderTick(held.deps, at("2026-10-14", 7));
  assert.equal(held.calls.length, 2);
  const again = rig(store);
  again.deps.config = held.deps.config;
  again.deps.readCalendars = held.deps.readCalendars;
  await reminderTick(again.deps, at("2026-10-14", 7.1));
  assert.equal(again.calls.length, 0);
});

test("a person can change their own mode, a parent can change a kid's, and a kid cannot change a parent", async () => {
  const store = await freshStore();
  const alex = CONFIG.members[0]!;
  const riley = CONFIG.members[2]!;
  const self = await setReminderMode(store, CONFIG.members, { from: "discord", member: riley }, "me", "off");
  assert.equal(self.ok, true);
  assert.match(self.text, /Riley/);
  const parent = await setReminderMode(store, CONFIG.members, { from: "discord", member: alex }, "riley", "dm");
  assert.equal(parent.ok, true);
  const kid = await setReminderMode(store, CONFIG.members, { from: "discord", member: riley }, "alex", "off");
  assert.equal(kid.ok, false);
  assert.equal((await store.reminderModes()).riley, "dm");
  assert.equal((await store.reminderModes()).alex, undefined);
});
