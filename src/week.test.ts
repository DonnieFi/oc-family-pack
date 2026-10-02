import assert from "node:assert/strict";
import { test } from "node:test";
import { boundWeekStart, localTime, pageWeekStart, startOfLocalDay } from "./week.ts";

const iso = (instant: number) => new Date(instant).toISOString();

test("local midnight accounts for daylight saving time", () => {
  assert.equal(iso(startOfLocalDay("2026-03-08", "America/Toronto")), "2026-03-08T05:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-11-01", "America/Toronto")), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-11-02", "America/Toronto")), "2026-11-02T05:00:00.000Z");
});

test("the America/Havana fall-back day starts at the first midnight", () => {
  assert.equal(iso(startOfLocalDay("2026-11-01", "America/Havana")), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-11-02", "America/Havana")), "2026-11-02T05:00:00.000Z");
});

test("a day whose midnight is skipped by DST begins at the shift, not the evening before", () => {
  assert.equal(iso(startOfLocalDay("2026-09-06", "America/Santiago")), "2026-09-06T04:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-03-08", "America/Havana")), "2026-03-08T05:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-09-07", "America/Santiago")), "2026-09-07T03:00:00.000Z");
});

test("a page start stays between 8 weeks back and 52 weeks ahead of today", () => {
  assert.equal(boundWeekStart("2026-10-01", "2026-10-02"), "2026-10-01");
  assert.equal(boundWeekStart("2026-08-07", "2026-10-02"), "2026-08-07");
  assert.equal(boundWeekStart("2027-10-01", "2026-10-02"), "2027-10-01");
  assert.equal(boundWeekStart("2026-01-01", "2026-10-02"), "2026-08-07");
  assert.equal(boundWeekStart("2028-01-01", "2026-10-02"), "2027-10-01");
  assert.equal(boundWeekStart("9999-12-31", "2026-10-02"), "2027-10-01");
  assert.equal(boundWeekStart("not-a-date", "2026-10-02"), undefined);
  assert.equal(boundWeekStart(undefined, "2026-10-02"), undefined);
});

test("previous and next stay on this week when the page window cannot move", () => {
  assert.equal(pageWeekStart("2026-08-03", -7, "2026-10-02"), undefined);
  assert.equal(pageWeekStart("2026-08-03", 7, "2026-10-02"), "2026-08-10");
  assert.equal(pageWeekStart("2027-09-27", 7, "2026-10-02"), undefined);
  assert.equal(pageWeekStart("2027-09-27", -7, "2026-10-02"), "2027-09-20");
  assert.equal(pageWeekStart("2026-09-28", -7, "2026-09-30"), "2026-09-21");
});

test("local times are read off the wall clock across a DST change", () => {
  assert.equal(iso(localTime("2026-11-01", 11, "America/Toronto")), "2026-11-01T16:00:00.000Z");
  assert.equal(iso(localTime("2026-10-31", 34, "America/Toronto")), "2026-11-01T15:00:00.000Z");
});
