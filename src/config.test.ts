import assert from "node:assert/strict";
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
      members: [{ ...member, devices: [] }],
      calendars: [
        { key: "c0", id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: [] },
        { key: "c1", id: "p1@example.com", label: "Parent", kind: "personal", owners: ["p1"] },
      ],
    },
  );
});

test("a config without a timezone uses the Gateway host's zone", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Halifax";
  try {
    assert.equal(parseConfig({ members: [member] }).timezone, "America/Halifax");
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
  const config = parseConfig({ demo: true, location: { lat: 45.42, lon: -75.7, label: "Ottawa" } });
  assert.deepEqual(config.location, { lat: 45.42, lon: -75.7, label: "Ottawa" });
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
