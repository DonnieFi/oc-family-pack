import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { narrowedAudience } from "./audience.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { buildWeekPayload } from "./payload.ts";
import { buildSchedule } from "./schedule.ts";
import type { CalendarConfig, MemberConfig } from "./types.ts";

const MEMBERS: MemberConfig[] = [
  { id: "alex", profileId: "alex", displayName: "Alex", role: "parent", devices: [] },
  { id: "riley", profileId: "riley", displayName: "Riley", role: "kid", cohorts: ["senior"], devices: [] },
  { id: "jordan", profileId: "jordan", displayName: "Jordan", role: "kid", cohorts: ["junior"], devices: [] },
];

const SCHOOL: CalendarConfig = { key: "c5", id: "demo-school", label: "School", kind: "school", owners: ["riley", "jordan"] };

test("the first matching rule narrows owners, and a school-wide rule leaves them unchanged", () => {
  const calendars = new Map([[SCHOOL.key, SCHOOL]]);
  const rules = [
    { title: "Choir", audience: "cohort" as const, cohort: "junior" },
    { title: "Mathematics", audience: "student" as const, students: ["riley", "alex"] },
    { title: "No school", audience: "school" as const },
  ];
  assert.deepEqual(narrowedAudience({ title: "Choir rehearsal", calendarKey: "c5" }, calendars, MEMBERS, rules), ["jordan"]);
  assert.deepEqual(narrowedAudience({ title: "Mathematics 10", calendarKey: "c5" }, calendars, MEMBERS, rules), ["riley"]);
  assert.equal(narrowedAudience({ title: "No school", calendarKey: "c5" }, calendars, MEMBERS, rules), undefined);
  assert.equal(narrowedAudience({ title: "Field trip", calendarKey: "c5" }, calendars, MEMBERS, rules), undefined);
});

test("an audience rule has to name a real school calendar and cannot add someone", () => {
  const raw = {
    timezone: "UTC",
    members: [
      { id: "alex", name: "Alex", role: "parent" },
      { id: "riley", name: "Riley", role: "kid", cohorts: ["Senior"] },
      { id: "jordan", name: "Jordan", role: "kid", cohorts: ["junior"] },
    ],
    calendars: [
      { key: "c5", id: "demo-school", label: "School", kind: "school", owners: ["riley", "jordan"] },
      { key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] },
    ],
  };
  const parsed = parseConfig({
    ...raw,
    audienceRules: [
      { title: "Choir", audience: "cohort", cohort: "Junior", calendar: "c5" },
      { title: "Mathematics", audience: "student", students: ["riley"] },
    ],
  });
  assert.equal(parsed.members.find((member) => member.id === "riley")?.cohorts?.[0], "senior");
  assert.equal(parsed.audienceRules?.[0]?.cohort, "junior");
  assert.throws(
    () => parseConfig({ ...raw, audienceRules: [{ title: "School", audience: "school" }, { title: "No school", audience: "student", students: ["riley"] }] }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("first matching rule wins"),
  );
  assert.throws(
    () => parseConfig({ ...raw, audienceRules: [{ title: "Choir", audience: "cohort", cohort: "junior", calendar: "c0" }] }),
    ConfigError,
  );
  assert.throws(
    () => parseConfig({ ...raw, audienceRules: [{ title: "Choir", audience: "student", students: ["alex"], calendar: "c5" }] }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("cannot widen"),
  );
});

test("two students on one school calendar see different classes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocfp-audience-"));
  const gogPath = join(dir, "gog");
  const events = JSON.stringify([
    { id: "math", summary: "Mathematics 10", start: { dateTime: "2026-10-14T13:00:00Z" }, end: { dateTime: "2026-10-14T14:00:00Z" } },
    { id: "choir", summary: "Choir rehearsal", start: { dateTime: "2026-10-14T20:00:00Z" }, end: { dateTime: "2026-10-14T21:00:00Z" } },
    { id: "closed", summary: "No school", start: { date: "2026-10-14" }, end: { date: "2026-10-15" } },
  ]);
  writeFileSync(gogPath, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  demo-school) echo '${events}' ;;\n  *) echo '[]' ;;\nesac\n`);
  chmodSync(gogPath, 0o755);
  const config = parseConfig({
    timezone: "America/Halifax",
    gogPath,
    members: [
      { id: "alex", profileId: "alex", name: "Alex", role: "parent" },
      { id: "riley", profileId: "riley", name: "Riley", role: "kid", cohorts: ["senior"] },
      { id: "jordan", profileId: "jordan", name: "Jordan", role: "kid", cohorts: ["junior"] },
    ],
    calendars: [{ key: "c5", id: "demo-school", label: "School", kind: "school", owners: ["riley", "jordan"] }],
    audienceRules: [
      { title: "Choir", audience: "cohort", cohort: "junior" },
      { title: "Mathematics", audience: "student", students: ["riley"] },
    ],
  });
  const now = Date.parse("2026-10-14T15:00:00Z");
  const textOf = async (member: string) => {
    const output = await buildSchedule(config, { start: "2026-10-14" }, { viewer: { kind: "member", id: member }, me: member }, now);
    return JSON.stringify(output);
  };
  try {
    const riley = await textOf("riley");
    assert.equal(riley.includes("Mathematics 10"), true);
    assert.equal(riley.includes("No school"), true);
    assert.equal(riley.includes("Choir"), false);
    const jordan = await textOf("jordan");
    assert.equal(jordan.includes("Choir rehearsal"), true);
    assert.equal(jordan.includes("No school"), true);
    assert.equal(jordan.includes("Mathematics"), false);
    const parent = await buildSchedule(config, { start: "2026-10-14" }, { viewer: { kind: "owner" } }, now);
    const parentText = JSON.stringify(parent);
    assert.equal(parentText.includes("Mathematics 10"), true);
    assert.equal(parentText.includes("Choir rehearsal"), true);
    assert.equal(parentText.includes("No school"), true);
    const weather = async () => ({ status: "unconfigured" as const, hint: "no weather" });
    const week = await buildWeekPayload(config, "2026-10-12", now, weather, { kind: "owner" });
    assert.equal(week.calendar.status, "ok");
    if (week.calendar.status !== "ok") return;
    const byTitle = new Map(week.calendar.data.map((event) => [event.title, event.audienceIds]));
    assert.deepEqual(byTitle.get("Mathematics 10"), ["riley"]);
    assert.deepEqual(byTitle.get("Choir rehearsal"), ["jordan"]);
    assert.equal(byTitle.get("No school"), undefined);
    const rileyWeek = await buildWeekPayload(config, "2026-10-12", now, weather, { kind: "person", username: "riley" });
    assert.equal(JSON.stringify(rileyWeek).includes("Choir"), false);
    assert.equal(JSON.stringify(rileyWeek).includes("Mathematics 10"), true);
    const jordanWeek = await buildWeekPayload(config, "2026-10-12", now, weather, { kind: "person", username: "jordan" });
    assert.equal(JSON.stringify(jordanWeek).includes("Mathematics"), false);
    assert.equal(JSON.stringify(jordanWeek).includes("Choir rehearsal"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
