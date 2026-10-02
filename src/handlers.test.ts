import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseConfig } from "./config.ts";
import { MembersPayloadSchema, WeatherStateSchema, WeekPayloadSchema } from "./contract.ts";
import { familyHandlers } from "./handlers.ts";

const DISCORD_ID = "100000000000000001";
const PRIMARY_MAC = "AA-BB-CC-DD-EE-01";
const ALIAS_MAC = "AA:BB:CC:DD:EE:02";

test("family.week handler returns one literal demo week", async () => {
  const config = parseConfig({ demo: true, timezone: "America/Toronto" });
  const week = await familyHandlers(config, { now: () => Date.parse("2026-09-30T16:00:00Z") })["family.week"]({
    start: "2026-10-01",
  });
  assert.deepEqual(week, {
    mode: "demo",
    range: { start: "2026-09-28", end: "2026-10-04", timezone: "America/Toronto" },
    today: "2026-09-30",
    days: [
      { date: "2026-09-28", isToday: false, eventIds: ["demo/t0", "demo/t1"] },
      { date: "2026-09-29", isToday: false, eventIds: ["demo/t2", "demo/t3"] },
      { date: "2026-09-30", isToday: true, eventIds: ["demo/a0", "demo/t4", "demo/t5"] },
      { date: "2026-10-01", isToday: false, eventIds: ["demo/t6", "demo/t7"] },
      { date: "2026-10-02", isToday: false, eventIds: ["demo/a2", "demo/a1", "demo/t8"] },
      { date: "2026-10-03", isToday: false, eventIds: ["demo/a2", "demo/t9", "demo/t10", "demo/t11"] },
      { date: "2026-10-04", isToday: false, eventIds: ["demo/a2", "demo/t11", "demo/t12"] },
    ],
    members: [
      { profileId: "alex", displayName: "Alex", role: "parent", color: "oklch(0.72 0.14 245)" },
      { profileId: "sam", displayName: "Sam", role: "parent", color: "oklch(0.72 0.16 55)" },
      { profileId: "riley", displayName: "Riley", role: "kid", color: "oklch(0.72 0.18 310)" },
      { profileId: "jordan", displayName: "Jordan", role: "kid", color: "oklch(0.75 0.15 150)" },
    ],
    calendars: [
      { key: "c0", label: "Alex", kind: "personal", ownerIds: ["alex"] },
      { key: "c1", label: "Sam", kind: "personal", ownerIds: ["sam"] },
      { key: "c2", label: "Riley", kind: "personal", ownerIds: ["riley"] },
      { key: "c3", label: "Jordan", kind: "personal", ownerIds: ["jordan"] },
      { key: "c4", label: "Family", kind: "shared", ownerIds: ["alex", "sam", "riley", "jordan"] },
      { key: "c5", label: "School", kind: "school", ownerIds: ["riley", "jordan"] },
    ],
    calendar: {
      status: "ok",
      warnings: [],
      data: [
        { id: "demo/a0", title: "Pizza lunch", start: "2026-09-30", end: "2026-10-01", allDay: true, calendarKey: "c5" },
        { id: "demo/a1", title: "PD day, no school", start: "2026-10-02", end: "2026-10-03", allDay: true, calendarKey: "c5" },
        { id: "demo/a2", title: "Grandparents visiting", start: "2026-10-02", end: "2026-10-05", allDay: true, calendarKey: "c4" },
        { id: "demo/t0", title: "School drop-off", start: "2026-09-28T12:15:00.000Z", end: "2026-09-28T12:45:00.000Z", allDay: false, calendarKey: "c4" },
        { id: "demo/t1", title: "Swim practice", start: "2026-09-28T22:00:00.000Z", end: "2026-09-28T23:00:00.000Z", allDay: false, location: "Community Pool", calendarKey: "c2" },
        { id: "demo/t2", title: "Dentist", start: "2026-09-29T13:30:00.000Z", end: "2026-09-29T14:30:00.000Z", allDay: false, location: "Family Dental", calendarKey: "c0" },
        { id: "demo/t3", title: "Piano lesson", start: "2026-09-29T20:30:00.000Z", end: "2026-09-29T21:30:00.000Z", allDay: false, location: "Music Studio", calendarKey: "c3" },
        { id: "demo/t4", title: "Team lunch", start: "2026-09-30T16:00:00.000Z", end: "2026-09-30T17:00:00.000Z", allDay: false, calendarKey: "c1" },
        { id: "demo/t5", title: "Parent-teacher night", start: "2026-09-30T23:00:00.000Z", end: "2026-10-01T00:30:00.000Z", allDay: false, location: "Elementary School", calendarKey: "c4" },
        { id: "demo/t6", title: "Soccer", start: "2026-10-01T21:00:00.000Z", end: "2026-10-01T22:30:00.000Z", allDay: false, location: "Riverside Park", calendarKey: "c2" },
        { id: "demo/t7", title: "Book club", start: "2026-10-01T22:30:00.000Z", end: "2026-10-01T23:30:00.000Z", allDay: false, location: "Main Library", calendarKey: "c1" },
        { id: "demo/t8", title: "Movie night", start: "2026-10-02T23:00:00.000Z", end: "2026-10-03T01:00:00.000Z", allDay: false, calendarKey: "c4" },
        { id: "demo/t9", title: "Farmers market", start: "2026-10-03T13:00:00.000Z", end: "2026-10-03T14:00:00.000Z", allDay: false, location: "Market Square", calendarKey: "c4" },
        { id: "demo/t10", title: "Birthday party", start: "2026-10-03T17:00:00.000Z", end: "2026-10-03T19:00:00.000Z", allDay: false, calendarKey: "c3" },
        { id: "demo/t11", title: "Sleepover", start: "2026-10-03T23:00:00.000Z", end: "2026-10-04T14:00:00.000Z", allDay: false, calendarKey: "c2" },
        { id: "demo/t12", title: "Grocery run", start: "2026-10-04T15:00:00.000Z", end: "2026-10-04T16:00:00.000Z", allDay: false, calendarKey: "c0" },
      ],
    },
    weather: { status: "unconfigured", hint: "Add location { lat, lon } to the plugin config to show local weather." },
  });
  assert.equal(Value.Check(WeekPayloadSchema, week), true);
});

test("family.members handler returns the picker roster and omits discord ids and device MACs", () => {
  const config = parseConfig({
    timezone: "UTC",
    members: [
      {
        profileId: "Riley",
        displayName: "Riley",
        role: "kid",
        discordId: DISCORD_ID,
        devices: [{ label: "Phone", primaryMac: PRIMARY_MAC, aliasMacs: [ALIAS_MAC], source: "dhcp" }],
      },
    ],
  });
  const roster = familyHandlers(config)["family.members"]();
  assert.deepEqual(roster, {
    members: [{ profileId: "riley", displayName: "Riley", role: "kid", color: "oklch(0.72 0.14 245)" }],
  });
  const wire = JSON.stringify(roster);
  for (const secret of [
    DISCORD_ID,
    "discordId",
    PRIMARY_MAC,
    ALIAS_MAC,
    "aa:bb:cc:dd:ee:01",
    "aa:bb:cc:dd:ee:02",
    "primaryMac",
    "aliasMacs",
    "devices",
    "Phone",
    "dhcp",
  ]) {
    assert.equal(wire.includes(secret), false, secret);
  }
  assert.equal(Value.Check(MembersPayloadSchema, roster), true);
  assert.equal(
    Value.Check(MembersPayloadSchema, { members: [{ ...roster.members[0], discordId: DISCORD_ID }] }),
    false,
  );
});

test("family.weather handler returns the Environment Canada card from the fixture", async () => {
  const ottawa = JSON.parse(readFileSync(new URL("./fixtures/ec-ottawa.json", import.meta.url), "utf8")) as unknown;
  const config = parseConfig({ timezone: "UTC", location: { lat: 45.42, lon: -75.7 } });
  const weather = await familyHandlers(config, { fetchWeather: async () => Response.json(ottawa) })["family.weather"]();
  assert.deepEqual(weather, {
    status: "ok",
    data: {
      stationName: "Ottawa (Kanata - Orléans)",
      observedAt: "2026-09-30T18:10:00Z",
      tempC: 15.9,
      condition: "Mostly Cloudy",
      highC: 21,
      lowC: 15,
      forecast: [
        { period: "Today", summary: "Periods of drizzle · High 21°" },
        { period: "Tonight", summary: "Mainly cloudy · Low 15°" },
        { period: "Thursday", summary: "Chance of showers · High 21°" },
        { period: "Thursday night", summary: "Chance of showers · Low 14°" },
      ],
      sourceUrl: "https://weather.gc.ca/en/location/index.html?coords=45.4,-75.69",
    },
  });
  assert.equal(Value.Check(WeatherStateSchema, weather), true);
});
