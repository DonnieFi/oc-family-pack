import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHighlightLines, GARBAGE_TOMORROW, QUIET_DAY, type HighlightEvent } from "./highlights.ts";

const TZ = "UTC";
const NOW = Date.parse("2026-10-02T15:00:00.000Z");

function event(summary: string, startMin: number, endMin: number, school = false): HighlightEvent {
  return {
    summary,
    startMs: NOW + startMin * 60_000,
    endMs: NOW + endMin * 60_000,
    allDay: false,
    school,
  };
}

test("highlight lines follow urgency, drop duplicates, and keep three", () => {
  const lines = buildHighlightLines(
    [
      event("Dentist", 90, 150),
      event("Dentist", 90, 150),
      event("Piano", 150, 210),
      event("Math", 30, 80, true),
      event("Gym", 200, 260, true),
      { summary: "Pizza lunch", startMs: NOW, endMs: NOW, allDay: true, school: true },
    ],
    NOW,
    TZ,
    true,
  );
  assert.deepEqual(lines, ["⏰ Dentist in 90 min", GARBAGE_TOMORROW, "📅 Piano at 05:30 PM"]);
});

test("a school class uses an unpadded clock, and one that ended an hour ago is left out", () => {
  assert.deepEqual(buildHighlightLines([event("Math", -50, 10, true)], NOW, TZ, false), ["🏫 Math · 2:10 PM"]);
  assert.deepEqual(buildHighlightLines([event("Math", -120, -60, true), event("Gym", -20, 40, true)], NOW, TZ, false), ["🏫 Gym · 2:40 PM"]);
  assert.deepEqual(buildHighlightLines([event("Math", -180, -60, true)], NOW, TZ, false), [QUIET_DAY]);
});

test("the four-hour line is padded, and the edges at now, two hours, and four hours are not soon", () => {
  assert.deepEqual(buildHighlightLines([event("Library", 120, 180)], NOW, TZ, false), ["📅 Library at 05:00 PM"]);
  assert.deepEqual(buildHighlightLines([event("Now", 0, 30), event("Later", 240, 300), event("Past", -5, 20)], NOW, TZ, false), [QUIET_DAY]);
  assert.deepEqual(buildHighlightLines([event("Soon", 119.9, 180)], NOW, TZ, false), ["⏰ Soon in 119 min"]);
});

test("no garbage flag and no events is the quiet line, and an all-day event is not urgent", () => {
  assert.deepEqual(buildHighlightLines([], NOW, TZ, false), [QUIET_DAY]);
  assert.deepEqual(buildHighlightLines([{ summary: "Trip", startMs: NOW, endMs: NOW, allDay: true, school: false }], NOW, TZ, false), [QUIET_DAY]);
  assert.deepEqual(buildHighlightLines([], NOW, TZ, true), [GARBAGE_TOMORROW]);
});
