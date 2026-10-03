import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseConfig } from "./config.ts";
import { WeekPayloadSchema } from "./contract.ts";
import { buildWeekPayload, fitWeek, jsonNodeCount } from "./payload.ts";
import type { FamilyEvent, WeekPayload } from "./types.ts";

const noWeather = async () => ({ status: "unconfigured" as const, hint: "no weather" });
const OWNER = { kind: "owner" } as const;
const NOW = Date.parse("2026-09-30T16:00:00Z");

test("discord ids and device MACs stay off the week payload", async () => {
  const config = parseConfig({
    timezone: "UTC",
    gogPath: "/bin/true",
    members: [
      {
        profileId: "Riley",
        displayName: "Riley",
        role: "kid",
        discordId: "100000000000000001",
        devices: [{ label: "Phone", primaryMac: "AA-BB-CC-DD-EE-01", aliasMacs: ["AA:BB:CC:DD:EE:02"], source: "dhcp" }],
      },
      { profileId: "Alex", displayName: "Alex", role: "parent" },
    ],
    calendars: [{ id: "school-feed@group.calendar.google.com", label: "School", kind: "school", owners: ["Riley"] }],
  });
  const payload = await buildWeekPayload(config, "2026-10-01", Date.parse("2026-09-30T16:00:00Z"), noWeather, OWNER);
  assert.deepEqual(payload.members, [
    { profileId: "riley", displayName: "Riley", role: "kid", color: "oklch(0.72 0.14 245)" },
    { profileId: "alex", displayName: "Alex", role: "parent", color: "oklch(0.72 0.16 55)" },
  ]);
  assert.deepEqual(payload.calendars, [{ key: "c0", label: "School", kind: "school", ownerIds: ["riley"] }]);
  const wire = JSON.stringify(payload);
  assert.equal(wire.includes("discordId"), false);
  assert.equal(wire.includes("100000000000000001"), false);
  assert.equal(wire.includes("devices"), false);
  assert.equal(wire.includes("primaryMac"), false);
  assert.equal(wire.includes("aa:bb:cc:dd:ee:01"), false);
  assert.equal(wire.includes("aa:bb:cc:dd:ee:02"), false);
});

test("demo mode renders a synthetic week with a roster, calendars, colors, and day buckets", async () => {
  const config = parseConfig({ demo: true, timezone: "America/Toronto" });
  const payload = await buildWeekPayload(config, "2026-10-01", Date.parse("2026-09-30T16:00:00Z"), noWeather, OWNER);
  assert.equal(payload.mode, "demo");
  assert.deepEqual(payload.range, { start: "2026-09-28", end: "2026-10-04", timezone: "America/Toronto" });
  assert.equal(payload.today, "2026-09-30");
  assert.deepEqual(payload.members, [
    { profileId: "alex", displayName: "Alex", role: "parent", color: "oklch(0.72 0.14 245)" },
    { profileId: "sam", displayName: "Sam", role: "parent", color: "oklch(0.72 0.16 55)" },
    { profileId: "riley", displayName: "Riley", role: "kid", color: "oklch(0.72 0.18 310)" },
    { profileId: "jordan", displayName: "Jordan", role: "kid", color: "oklch(0.75 0.15 150)" },
  ]);
  assert.deepEqual(payload.calendars, [
    { key: "c0", label: "Alex", kind: "personal", ownerIds: ["alex"] },
    { key: "c1", label: "Sam", kind: "personal", ownerIds: ["sam"] },
    { key: "c2", label: "Riley", kind: "personal", ownerIds: ["riley"] },
    { key: "c3", label: "Jordan", kind: "personal", ownerIds: ["jordan"] },
    { key: "c4", label: "Family", kind: "shared", ownerIds: ["alex", "sam", "riley", "jordan"] },
    { key: "c5", label: "School", kind: "school", ownerIds: ["riley", "jordan"] },
  ]);
  assert.deepEqual(
    payload.days.map((day) => [day.date, day.isToday, day.eventIds]),
    [
      ["2026-09-28", false, ["demo/t0", "demo/t1"]],
      ["2026-09-29", false, ["demo/t2", "demo/t3"]],
      ["2026-09-30", true, ["demo/a0", "demo/t4", "demo/t5"]],
      ["2026-10-01", false, ["demo/t6", "demo/t7"]],
      ["2026-10-02", false, ["demo/a2", "demo/a1", "demo/t8"]],
      ["2026-10-03", false, ["demo/a2", "demo/t9", "demo/t10", "demo/t11"]],
      ["2026-10-04", false, ["demo/a2", "demo/t11", "demo/t12"]],
    ],
  );
  assert.deepEqual(payload.calendar.status === "ok" && payload.calendar.data.find((event) => event.id === "demo/t0"), {
    id: "demo/t0",
    title: "School drop-off",
    start: "2026-09-28T12:15:00.000Z",
    end: "2026-09-28T12:45:00.000Z",
    allDay: false,
    calendarKey: "c4",
  });
  assert.deepEqual(payload.weather, { status: "unconfigured", hint: "no weather" });
});

test("demo events keep their wall-clock times in a week where DST ends", async () => {
  const config = parseConfig({ demo: true, timezone: "America/Toronto" });
  const payload = await buildWeekPayload(config, "2026-11-01", Date.parse("2026-10-28T16:00:00Z"), noWeather, OWNER);
  const times = (id: string) => {
    const event = payload.calendar.status === "ok" ? payload.calendar.data.find((entry) => entry.id === id) : undefined;
    return event && [event.start, event.end];
  };
  assert.deepEqual(
    [times("demo/t0"), times("demo/t11"), times("demo/t12")],
    [
      ["2026-10-26T12:15:00.000Z", "2026-10-26T12:45:00.000Z"],
      ["2026-10-31T23:00:00.000Z", "2026-11-01T15:00:00.000Z"],
      ["2026-11-01T16:00:00.000Z", "2026-11-01T17:00:00.000Z"],
    ],
  );
});

const DATES = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

/** Every list at its schema maximum, and every event spanning all seven days. */
function busiestWeek(eventCount: number, event: (index: number) => Omit<FamilyEvent, "id" | "calendarKey"> = (index) => ({
  title: `Event ${index}`,
  start: "2026-09-28",
  end: "2026-10-05",
  allDay: true,
  location: "Community Pool",
  htmlLink: "https://calendar.google.com/event?eid=e",
})): WeekPayload {
  const members = Array.from({ length: 32 }, (_, index) => `m${index}`);
  const events = Array.from({ length: eventCount }, (_, index) => ({ id: `c${index % 16}/e${index}`, calendarKey: `c${index % 16}`, ...event(index) }));
  return {
    mode: "live",
    range: { start: "2026-09-28", end: "2026-10-04", timezone: "America/Toronto" },
    today: "2026-09-30",
    days: DATES.map((date) => ({ date, isToday: date === "2026-09-30", eventIds: events.map((entry) => entry.id) })),
    members: members.map((profileId) => ({ profileId, displayName: profileId, color: "oklch(0.72 0.14 245)", role: "parent" })),
    calendars: Array.from({ length: 16 }, (_, index) => ({ key: `c${index}`, label: `Calendar ${index}`, kind: "personal", ownerIds: members })),
    calendar: { status: "ok", data: events, warnings: Array.from({ length: 16 }, (_, index) => `Could not read the "Calendar ${index}" calendar: gog timed out`) },
    weather: {
      status: "ok",
      data: {
        stationName: "Home",
        observedAt: "2026-09-30T15:00:00Z",
        tempC: 14,
        condition: "Cloudy",
        highC: 17,
        lowC: 6,
        forecast: Array.from({ length: 8 }, (_, index) => ({ period: `Period ${index}`, summary: "Cloudy" })),
        sourceUrl: "https://weather.gc.ca/",
      },
    },
  };
}

test("the busiest allowed week fits the host's node budget and the output schema", () => {
  const payload = busiestWeek(200);
  assert.deepEqual([jsonNodeCount(payload), Value.Check(WeekPayloadSchema, payload), fitWeek(payload) === payload], [4045, true, true]);
});

test("a week over the event cap or the host's size limit becomes a calendar error instead of a rejected query", () => {
  const tooMany = fitWeek(busiestWeek(201));
  const tooLarge = fitWeek(
    busiestWeek(150, (index) => ({ title: `Event ${index}`, start: "2026-09-28", end: "2026-09-29", allDay: true, location: "L".repeat(500), htmlLink: `https://calendar.google.com/${"a".repeat(2000)}` })),
  );
  assert.deepEqual(
    [tooMany, tooLarge].map((payload) => [payload.calendar, payload.days.flatMap((day) => day.eventIds).length, payload.members.length, payload.weather.status]),
    [
      [{ status: "error", message: "This week has 201 events, more than Family can show at once. Remove a busy calendar from the plugin config." }, 0, 32, "ok"],
      [{ status: "error", message: "This week is 418667 bytes, more than Family can show at once. Remove a busy calendar from the plugin config." }, 0, 32, "ok"],
    ],
  );
  assert.equal(Value.Check(WeekPayloadSchema, tooMany), true);
});

test("a family.week start of 9999-12-31 is a config error instead of a range crash", async () => {
  const config = parseConfig({ demo: true, timezone: "UTC" });
  await assert.rejects(() => buildWeekPayload(config, "9999-12-31", Date.parse("2026-09-30T16:00:00Z"), noWeather, OWNER), {
    name: "ConfigError",
    message: "oc-family-pack config: start must be a week Family can show",
  });
});

test("a kid's demo week holds only shared, school and their own calendars and events", async () => {
  const config = parseConfig({ demo: true, timezone: "America/Toronto" });
  const everything = await buildWeekPayload(config, "2026-10-01", NOW, noWeather, OWNER);
  const riley = await buildWeekPayload(config, "2026-10-01", NOW, noWeather, { kind: "person", username: "riley" });
  assert.deepEqual(riley.calendars.map((calendar) => calendar.label).sort(), ["Family", "Riley", "School"]);
  assert.ok(riley.calendar.status === "ok" && everything.calendar.status === "ok");
  const keys = new Set(riley.calendars.map((calendar) => calendar.key));
  const kept = everything.calendar.data.filter((event) => keys.has(event.calendarKey));
  assert.ok(kept.length > 0 && kept.length < everything.calendar.data.length, "the demo week should have events on both sides");
  assert.deepEqual(riley.calendar.data, kept);
  assert.deepEqual([...new Set(riley.days.flatMap((day) => day.eventIds))].sort(), kept.map((event) => event.id).sort());
  assert.deepEqual(riley.members, everything.members);
});

test("a viewer with no calendars of theirs gets the hidden state without reading any calendar", async () => {
  const config = parseConfig({
    timezone: "America/Toronto",
    gogPath: "/nonexistent/gog-must-not-run",
    members: [{ profileId: "alex", displayName: "Alex", role: "parent" }, { profileId: "riley", displayName: "Riley", role: "kid" }],
    calendars: [{ id: "alex-work@example.com", label: "Work", kind: "personal", owners: ["alex"] }],
  });
  const riley = await buildWeekPayload(config, "2026-10-01", NOW, noWeather, { kind: "person", username: "riley" });
  assert.deepEqual(riley.calendars, []);
  assert.deepEqual(riley.calendar, { status: "hidden" });
  assert.ok(riley.days.every((day) => day.eventIds.length === 0));
});
