import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunGog } from "./calendar-gog.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { buildWeekPayload } from "./payload.ts";
import { eventParticipants, hasName } from "./participants.ts";
import { buildSchedule } from "./schedule.ts";
import type { Config, MemberConfig } from "./types.ts";

const MEMBERS: MemberConfig[] = [
  { id: "alex", profileId: "alex", displayName: "Alex", role: "parent", email: "alex@example.com", devices: [] },
  { id: "riley", profileId: "riley", displayName: "Riley Smith", role: "kid", aliases: ["kid"], email: "riley@example.com", devices: [] },
  { id: "jordan", profileId: "jordan", displayName: "Jordan", role: "kid", aliases: ["kid"], devices: [] },
];

test("a title names one person, and a shared or partial word does not", () => {
  assert.equal(hasName("Riley dentist", "riley"), true);
  assert.equal(hasName("Rileys dentist", "riley"), false);
  assert.equal(hasName("Riverside market", "riley"), false);
  const dentist = eventParticipants({ id: "c0/dentist", calendarKey: "c0", title: "Riley dentist", google: { eventId: "dentist" } }, MEMBERS);
  assert.deepEqual(dentist.ids, ["riley"]);
  assert.deepEqual(dentist.ambiguous, []);
  const phrase = eventParticipants({ id: "c0/full", calendarKey: "c0", title: "Riley Smith checkup" }, MEMBERS);
  assert.deepEqual(phrase.ids, ["riley"]);
  const shared = eventParticipants({ id: "c0/kid", calendarKey: "c0", title: "kid checkup" }, MEMBERS);
  assert.deepEqual(shared.ids, []);
  assert.deepEqual(shared.ambiguous, ["kid"]);
  const confirmed = eventParticipants({ id: "c0/kid", calendarKey: "c0", title: "kid checkup", google: { eventId: "kid" } }, MEMBERS, [
    { calendarKey: "c0", eventId: "kid", memberId: "riley", decision: "confirm" },
  ]);
  assert.deepEqual(confirmed.ids, ["riley"]);
  const rejected = eventParticipants({ id: "c0/dentist", calendarKey: "c0", title: "Riley dentist", google: { eventId: "dentist" } }, MEMBERS, [
    { calendarKey: "c0", eventId: "dentist", memberId: "riley", decision: "reject" },
  ]);
  assert.deepEqual(rejected.ids, []);
  const invited = eventParticipants(
    {
      id: "c0/clean",
      calendarKey: "c0",
      title: "Cleaning",
      google: { eventId: "clean", attendees: [{ email: "riley@example.com" }] },
    },
    MEMBERS,
  );
  assert.deepEqual(invited.ids, ["riley"]);
  const noted = eventParticipants({ id: "c0/note", calendarKey: "c0", title: "Cleaning", google: { eventId: "note" } }, MEMBERS);
  assert.deepEqual(noted.ids, []);
});

test("a participant override has to name one known calendar, event, and person", () => {
  const raw = {
    timezone: "UTC",
    members: [
      { id: "alex", name: "Alex", role: "parent" },
      { id: "riley", name: "Riley", role: "kid" },
    ],
    calendars: [{ key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] }],
  };
  assert.equal(parseConfig({ ...raw, participantOverrides: [{ calendar: "c0", event: "dentist", member: "riley", decision: "confirm" }] }).participantOverrides?.[0]?.memberId, "riley");
  assert.throws(() => parseConfig({ ...raw, participantOverrides: [{ calendar: "c0", event: "dentist", member: "riley", decision: "confirm" }, { calendar: "c0", event: "dentist", member: "riley", decision: "reject" }] }), ConfigError);
  assert.throws(() => parseConfig({ ...raw, participantOverrides: [{ calendar: "c9", event: "dentist", member: "riley", decision: "confirm" }] }), ConfigError);
});

const NOW = Date.parse("2026-10-14T15:00:00Z");

function live(overrides?: Config["participantOverrides"]) {
  const config = parseConfig({
    timezone: "America/Halifax",
    gogPath: "/fake/gog",
    members: [
      { id: "alex", profileId: "alex", name: "Alex", role: "parent" },
      { id: "riley", profileId: "riley", name: "Riley", role: "kid", email: "riley@example.com" },
      { id: "jordan", profileId: "jordan", name: "Jordan", role: "kid" },
    ],
    calendars: [
      { key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] },
      { key: "c1", id: "demo-riley", label: "Riley", kind: "personal", owners: ["riley"] },
      { key: "c2", id: "demo-family", label: "Family", kind: "shared", owners: ["alex", "riley", "jordan"] },
    ],
    ...(overrides ? { participantOverrides: overrides.map((row) => ({ calendar: row.calendarKey, event: row.eventId, member: row.memberId, decision: row.decision })) } : {}),
  });
  const calls: string[][] = [];
  const events: Record<string, unknown[]> = {
    "demo-alex": [
      { id: "dentist", summary: "Riley dentist", start: { dateTime: "2026-10-14T13:00:00Z" }, end: { dateTime: "2026-10-14T14:00:00Z" } },
      { id: "grocery", summary: "Grocery", start: { dateTime: "2026-10-14T15:00:00Z" }, end: { dateTime: "2026-10-14T16:00:00Z" } },
      { id: "gone", summary: "Riley dentist", status: "cancelled", start: { dateTime: "2026-10-14T17:00:00Z" }, end: { dateTime: "2026-10-14T18:00:00Z" } },
    ],
    "demo-riley": [],
    "demo-family": [],
  };
  const runGog: RunGog = async (_file, args) => {
    calls.push(args);
    const id = args.at(-1) ?? "";
    return { stdout: JSON.stringify({ events: events[id] ?? [] }) };
  };
  return { config, runGog, calls };
}

test("Riley sees the named appointment, Jordan does not, and nothing is copied", async () => {
  const { config, runGog, calls } = live();
  const riley = await buildSchedule(config, { start: "2026-10-14", member: "riley" }, { viewer: { kind: "member", id: "riley" }, me: "riley" }, NOW, runGog);
  assert.ok("sections" in riley);
  const items = riley.sections.flatMap((section) => section.items);
  assert.deepEqual(items.map((item) => item.title), ["Riley dentist"]);
  assert.deepEqual(items[0]?.owners, ["Alex"]);
  assert.deepEqual(items[0]?.participants, ["Riley"]);
  const jordan = await buildSchedule(config, { start: "2026-10-14" }, { viewer: { kind: "member", id: "jordan" }, me: "jordan" }, NOW, runGog);
  assert.equal(JSON.stringify(jordan).includes("Riley dentist"), false);
  assert.equal(JSON.stringify(jordan).includes("Grocery"), false);
  assert.equal(calls.some((args) => args.some((arg) => /insert|update|delete|invite/i.test(arg))), false);
});

test("a kid's week keeps the named event and leaves the hidden calendar off the list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocfp-named-"));
  const gogPath = join(dir, "gog");
  const alex = JSON.stringify([
    { id: "dentist", summary: "Riley dentist", start: { dateTime: "2026-10-14T13:00:00Z" }, end: { dateTime: "2026-10-14T14:00:00Z" } },
    { id: "grocery", summary: "Grocery", start: { dateTime: "2026-10-14T15:00:00Z" }, end: { dateTime: "2026-10-14T16:00:00Z" } },
  ]);
  writeFileSync(gogPath, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  demo-alex) echo '${alex}' ;;\n  *) echo '[]' ;;\nesac\n`);
  chmodSync(gogPath, 0o755);
  const config = parseConfig({
    timezone: "America/Halifax",
    gogPath,
    members: [
      { id: "alex", profileId: "alex", name: "Alex", role: "parent" },
      { id: "riley", profileId: "riley", name: "Riley", role: "kid" },
      { id: "jordan", profileId: "jordan", name: "Jordan", role: "kid" },
    ],
    calendars: [
      { key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] },
      { key: "c1", id: "demo-riley", label: "Riley", kind: "personal", owners: ["riley"] },
    ],
  });
  const weather = async () => ({ status: "unconfigured" as const, hint: "no weather" });
  try {
    const riley = await buildWeekPayload(config, "2026-10-12", NOW, weather, { kind: "person", username: "riley" });
    assert.deepEqual(riley.calendars.map((calendar) => calendar.label), ["Riley"]);
    assert.equal(riley.calendar.status, "ok");
    if (riley.calendar.status !== "ok") return;
    assert.deepEqual(
      riley.calendar.data.map((event) => [event.title, event.participantIds]),
      [["Riley dentist", ["riley"]]],
    );
    assert.equal(JSON.stringify(riley).includes("demo-alex"), false);
    assert.equal(JSON.stringify(riley).includes("Grocery"), false);
    const jordan = await buildWeekPayload(config, "2026-10-12", NOW, weather, { kind: "person", username: "jordan" });
    assert.equal(JSON.stringify(jordan).includes("Riley dentist"), false);
    const parent = await buildWeekPayload(config, "2026-10-12", NOW, weather, { kind: "owner" });
    assert.equal(parent.calendar.status, "ok");
    if (parent.calendar.status !== "ok") return;
    assert.deepEqual(parent.calendar.data.map((event) => event.title).sort(), ["Grocery", "Riley dentist"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
