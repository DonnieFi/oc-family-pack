import assert from "node:assert/strict";
import { test } from "node:test";
import { localTime, startOfLocalDay } from "./week.ts";

const iso = (instant: number) => new Date(instant).toISOString();

test("local midnight accounts for daylight saving time", () => {
  assert.equal(iso(startOfLocalDay("2026-03-08", "America/Toronto")), "2026-03-08T05:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-11-01", "America/Toronto")), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-11-02", "America/Toronto")), "2026-11-02T05:00:00.000Z");
});

test("a day whose midnight is skipped by DST begins at the shift, not the evening before", () => {
  assert.equal(iso(startOfLocalDay("2026-09-06", "America/Santiago")), "2026-09-06T04:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-03-08", "America/Havana")), "2026-03-08T05:00:00.000Z");
  assert.equal(iso(startOfLocalDay("2026-09-07", "America/Santiago")), "2026-09-07T03:00:00.000Z");
});

test("local times are read off the wall clock across a DST change", () => {
  assert.equal(iso(localTime("2026-11-01", 11, "America/Toronto")), "2026-11-01T16:00:00.000Z");
  assert.equal(iso(localTime("2026-10-31", 34, "America/Toronto")), "2026-11-01T15:00:00.000Z");
});
