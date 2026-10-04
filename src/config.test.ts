import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "./config.ts";

const member = { profileId: "p1", displayName: "Parent One", role: "parent" };

test("a minimal live config fills defaults and keys calendars by position", () => {
  assert.deepEqual(
    parseConfig({
      timezone: "America/Toronto",
      members: [member],
      calendars: [
        { id: "family@group.calendar.google.com", label: "Family", kind: "shared" },
        { id: "p1@example.com", label: "Parent", kind: "personal", owners: ["p1"] },
      ],
    }),
    {
      timezone: "America/Toronto",
      demo: false,
      gogPath: "gog",
      writes: "on",
      reminderLeadMinutes: [15],
      quietHours: { startHour: 22, endHour: 7 },
      schoolHints: [],
      closedDayPhrases: [],
      members: [{ ...member, devices: [], reminders: "dm" }],
      calendars: [
        { key: "c0", id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: [] },
        { key: "c1", id: "p1@example.com", label: "Parent", kind: "personal", owners: ["p1"] },
      ],
    },
  );
});

test("a config without a timezone uses the Gateway host's zone", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    assert.equal(parseConfig({ members: [member] }).timezone, "America/Chicago");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("config errors name the offending field", () => {
  const cases: [unknown, string][] = [
    [{ timezone: "Mars/Olympus" }, 'oc-family-pack config: timezone must be an IANA time zone such as America/Toronto (got "Mars/Olympus")'],
    [{ timezone: "UTC", members: [{ ...member, role: "pet" }] }, "oc-family-pack config: members[0].role must be one of parent, kid, guest"],
    [
      { timezone: "UTC", members: [member], calendars: [{ id: "c1", label: "School", kind: "school", owners: ["p2"] }] },
      'oc-family-pack config: calendars[0].owners[0] "p2" does not match any members[].profileId',
    ],
    [{ timezone: "UTC", members: [member, member] }, 'oc-family-pack config: members[].profileId contains "p1" more than once'],
    [{ demo: true, location: { lat: 95, lon: 0 } }, "oc-family-pack config: location.lat must be a number between -90 and 90"],
    [{ demo: true, members: [{ ...member, color: "red;background:url(x)" }] }, "oc-family-pack config: members[0].color must be a CSS color such as #3b82f6 or oklch(0.72 0.14 245)"],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseConfig(raw), { name: "ConfigError", message });
  }
});

test("demo mode reads its location", () => {
  const config = parseConfig({ demo: true, location: { lat: 45.42, lon: -75.7, label: "Home" } });
  assert.deepEqual(config.location, { lat: 45.42, lon: -75.7, label: "Home" });
  assert.equal(config.demo, true);
});

test("a hyphenated MAC is stored lowercase and colon-separated", () => {
  const config = parseConfig({
    timezone: "UTC",
    members: [
      {
        profileId: "riley",
        displayName: "Riley",
        role: "kid",
        discordId: "100000000000000001",
        devices: [
          {
            label: "Phone",
            primaryMac: "AA-BB-CC-DD-EE-01",
            aliasMacs: ["AA:BB:CC:DD:EE:02", "aabb.ccdd.ee03", "AABBCCDDEE04", "aa bb cc dd ee 05"],
            source: "dhcp",
          },
        ],
      },
    ],
  });
  assert.deepEqual(config.members[0]?.devices, [
    {
      label: "Phone",
      primaryMac: "aa:bb:cc:dd:ee:01",
      aliasMacs: ["aa:bb:cc:dd:ee:02", "aa:bb:cc:dd:ee:03", "aa:bb:cc:dd:ee:04", "aa:bb:cc:dd:ee:05"],
      source: "dhcp",
    },
  ]);
  assert.equal(config.members[0]?.discordId, "100000000000000001");
});

test("an invalid MAC is rejected with the member's name", () => {
  assert.throws(
    () =>
      parseConfig({
        timezone: "UTC",
        members: [
          {
            profileId: "riley",
            displayName: "Riley",
            role: "kid",
            devices: [{ label: "Phone", primaryMac: "AA-BB-CC-DD-EE-0G", aliasMacs: [], source: "dhcp" }],
          },
        ],
      }),
    { name: "ConfigError", message: "oc-family-pack config: members[0].devices[0].primaryMac must be a MAC address for Riley" },
  );
  assert.throws(
    () =>
      parseConfig({
        timezone: "UTC",
        members: [
          {
            profileId: "riley",
            displayName: "Riley",
            role: "kid",
            devices: [{ label: "Phone", primaryMac: "aa:bb:cc:dd:ee:01", aliasMacs: ["nope"], source: "dhcp" }],
          },
        ],
      }),
    { name: "ConfigError", message: "oc-family-pack config: members[0].devices[0].aliasMacs[0] must be a MAC address for Riley" },
  );
});

test("profile ids are stored lowercased and uniqueness runs after that", () => {
  const config = parseConfig({
    timezone: "UTC",
    members: [{ profileId: "Riley", displayName: "Riley", role: "kid" }],
  });
  assert.equal(config.members[0]?.profileId, "riley");
  assert.throws(
    () =>
      parseConfig({
        timezone: "UTC",
        members: [
          { profileId: "Riley", displayName: "Riley", role: "kid" },
          { profileId: "riley", displayName: "Riley Two", role: "kid" },
        ],
      }),
    { name: "ConfigError", message: 'oc-family-pack config: members[].profileId contains "riley" more than once' },
  );
});

const snowflake = "100000000000000001";

test("discord ids are unique across the roster", () => {
  assert.throws(
    () =>
      parseConfig({
        timezone: "UTC",
        members: [
          { profileId: "riley", displayName: "Riley", role: "kid", discordId: snowflake },
          { profileId: "alex", displayName: "Alex", role: "parent", discordId: snowflake },
        ],
      }),
    { name: "ConfigError", message: `oc-family-pack config: members[].discordId contains "${snowflake}" more than once` },
  );
});

test("a discord id must be a numeric snowflake", () => {
  assert.throws(
    () =>
      parseConfig({
        timezone: "UTC",
        members: [{ profileId: "riley", displayName: "Riley", role: "kid", discordId: `<@${snowflake}>` }],
      }),
    { name: "ConfigError", message: "oc-family-pack config: members[0].discordId must be a numeric Discord user id" },
  );
});

test("calendar owners are stored lowercased", () => {
  const config = parseConfig({
    timezone: "UTC",
    members: [{ profileId: "riley", displayName: "Riley", role: "kid" }],
    calendars: [{ id: "school-feed@group.calendar.google.com", label: "School", kind: "school", owners: ["RILEY"] }],
  });
  assert.deepEqual(config.calendars[0]?.owners, ["riley"]);
});

test("a school calendar is attributed from its owners alone", () => {
  const members = [
    { profileId: "riley", displayName: "Riley", role: "kid" },
    { profileId: "alex", displayName: "Alex", role: "parent" },
  ];
  const attributed = parseConfig({
    timezone: "UTC",
    members,
    calendars: [
      {
        id: "school-feed@group.calendar.google.com",
        label: "School",
        kind: "school",
        owners: ["Riley"],
        student: "alex",
      },
    ],
  });
  assert.deepEqual(attributed.calendars[0], {
    key: "c0",
    id: "school-feed@group.calendar.google.com",
    label: "School",
    kind: "school",
    owners: ["riley"],
  });
  const unassigned = parseConfig({
    timezone: "UTC",
    members,
    calendars: [{ id: "school-feed@group.calendar.google.com", label: "School", kind: "school" }],
  });
  assert.deepEqual(unassigned.calendars[0]?.owners, []);
});

test("writes is on by default, takes confirm or off, and refuses anything else", () => {
  assert.equal(parseConfig({}).writes, "on");
  assert.equal(parseConfig({ writes: "confirm" }).writes, "confirm");
  assert.equal(parseConfig({ writes: "off" }).writes, "off");
  for (const writes of ["OFF", "", true, null, "draft"]) {
    assert.throws(() => parseConfig({ writes }), { message: "oc-family-pack config: writes must be one of on, confirm, off" }, String(writes));
  }
});

test("garbageIcsUrl is optional, trimmed, and only an http or https link", () => {
  assert.equal(Object.hasOwn(parseConfig({ timezone: "UTC" }), "garbageIcsUrl"), false);
  const url = "https://recollect.example/api/places/PLACE-1234/services/waste/events.en.ics?client_id=abc";
  assert.equal(parseConfig({ timezone: "UTC", garbageIcsUrl: ` ${url} ` }).garbageIcsUrl, url);
  assert.equal(parseConfig({ timezone: "UTC", garbageIcsUrl: "HTTP://127.0.0.1:8080/feed.ics" }).garbageIcsUrl, "HTTP://127.0.0.1:8080/feed.ics");
  const message = "oc-family-pack config: garbageIcsUrl must be an http or https link to an .ics calendar (for a webcal:// link, use https:// instead)";
  for (const bad of ["webcal://recollect.example/feed.ics", "file:///etc/passwd", "recollect.example/feed.ics", "javascript:alert(1)"]) {
    assert.throws(() => parseConfig({ timezone: "UTC", garbageIcsUrl: bad }), { name: "ConfigError", message }, bad);
  }
  for (const bad of ["", "  ", 42]) {
    assert.throws(() => parseConfig({ timezone: "UTC", garbageIcsUrl: bad }), { name: "ConfigError", message: "oc-family-pack config: garbageIcsUrl must be a non-empty string" }, String(bad));
  }
});

test("the garbage calendar link is marked sensitive, so the Control UI masks it: the link encodes the household's address", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { uiHints: Record<string, { sensitive?: boolean }> };
  assert.equal(manifest.uiHints.garbageIcsUrl?.sensitive, true);
});

test("reminders default to a 15 minute lead, quiet hours 22:00 to 07:00, and a direct message", () => {
  const parsed = parseConfig({ timezone: "UTC", members: [{ profileId: "alex", displayName: "Alex", role: "parent", reminders: "off" }] });
  assert.deepEqual(parsed.reminderLeadMinutes, [15]);
  assert.deepEqual(parsed.quietHours, { startHour: 22, endHour: 7 });
  assert.equal(parsed.members[0]!.reminders, "off");
  assert.deepEqual(parseConfig({ timezone: "UTC", reminderLeadMinutes: [60, 15], quietHours: { startHour: 21, endHour: 6 } }).reminderLeadMinutes, [60, 15]);
  assert.throws(() => parseConfig({ timezone: "UTC", reminderLeadMinutes: [15, 15] }), /must not repeat/);
  assert.throws(() => parseConfig({ timezone: "UTC", quietHours: { startHour: 24, endHour: 7 } }), /quietHours.startHour/);
  assert.throws(() => parseConfig({ timezone: "UTC", members: [{ profileId: "alex", displayName: "Alex", role: "kid", reminders: "sms" }] }), /reminders must be one of/);
});

test("household jobs take a clock time and ship with empty phrase lists", () => {
  const parsed = parseConfig({
    timezone: "UTC",
    morningTime: "07:15",
    afterSchoolTime: "15:30",
    weekendPreviewTime: "18:00",
    weekendPreviewWeekday: 5,
    schoolHints: ["Field Trip"],
    closedDayPhrases: ["No School"],
  });
  assert.equal(parsed.morningTime, "07:15");
  assert.equal(parsed.afterSchoolTime, "15:30");
  assert.equal(parsed.weekendPreviewTime, "18:00");
  assert.equal(parsed.weekendPreviewWeekday, 5);
  assert.deepEqual(parsed.schoolHints, ["field trip"]);
  assert.deepEqual(parsed.closedDayPhrases, ["no school"]);
  assert.deepEqual(parseConfig({ timezone: "UTC" }).schoolHints, []);
  assert.throws(() => parseConfig({ timezone: "UTC", morningTime: "7am" }), /morningTime/);
  assert.throws(() => parseConfig({ timezone: "UTC", weekendPreviewWeekday: 7 }), /weekendPreviewWeekday/);
  assert.throws(() => parseConfig({ timezone: "UTC", schoolHints: ["trip", "Trip"] }), /must not repeat/);
});

test("summaryChannel names a key in channels; a key that isn't there fails the config at load", () => {
  const parsed = parseConfig({ timezone: "UTC", channels: { "family-briefs": " 222222222222222222 " }, summaryChannel: "family-briefs" });
  assert.deepEqual(parsed.channels, { "family-briefs": "222222222222222222" });
  assert.equal(parsed.summaryChannel, "family-briefs");
  assert.equal(Object.hasOwn(parseConfig({ timezone: "UTC" }), "summaryChannel"), false);
  for (const config of [
    { channels: { "family-briefs": "222222222222222222" }, summaryChannel: "kitchen" },
    { summaryChannel: "family-briefs" },
    { channels: { "family-briefs": "222222222222222222" }, summaryChannel: "222222222222222222" },
  ]) {
    assert.throws(() => parseConfig({ timezone: "UTC", ...config }), { name: "ConfigError", message: `oc-family-pack config: summaryChannel "${config.summaryChannel}" does not match any key in channels` }, JSON.stringify(config));
  }
});

test("channels map short keys to numeric Discord channel ids", () => {
  assert.throws(() => parseConfig({ channels: { "Family Briefs": "222222222222222222" } }), { message: "oc-family-pack config: channels.Family Briefs must be a key of lowercase letters, digits and hyphens, such as family-briefs" });
  assert.throws(() => parseConfig({ channels: { briefs: "#family" } }), { message: "oc-family-pack config: channels.briefs must be a numeric Discord channel id" });
  assert.throws(() => parseConfig({ channels: ["222222222222222222"] }), { message: "oc-family-pack config: channels must be an object of channel key to Discord channel id" });
});
