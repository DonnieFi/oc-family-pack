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
      members: [member],
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
