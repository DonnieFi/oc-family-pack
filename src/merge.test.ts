import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCopies } from "./merge.ts";
import type { FamilyEvent } from "./types.ts";

const timed = (id: string, calendarKey: string, title: string, start: string, extra: Partial<FamilyEvent> = {}): FamilyEvent => ({
  id,
  title,
  start,
  end: "2026-09-30T23:00:00.000Z",
  allDay: false,
  calendarKey,
  ...extra,
});

test("copies whose normalized titles match within 15 minutes become one event from the earliest copy", () => {
  const merged = mergeCopies([
    timed("c2/b", "c2", " soccer   PRACTICE ", "2026-09-30T21:14:00.000Z", { htmlLink: "https://calendar.google.com/event?eid=b", location: "Riverside Park" }),
    timed("c0/a", "c0", "Ｓoccer practice", "2026-09-30T21:00:00.000Z"),
  ]);
  assert.deepEqual(merged, [
    {
      id: "c0/a",
      title: "Ｓoccer practice",
      start: "2026-09-30T21:00:00.000Z",
      end: "2026-09-30T23:00:00.000Z",
      allDay: false,
      calendarKey: "c0",
      calendarKeys: ["c0", "c2"],
      location: "Riverside Park",
      htmlLink: "https://calendar.google.com/event?eid=b",
    },
  ]);
});

test("each copy is compared with the earliest in its group, so 9:00, 9:14 and 9:28 do not chain", () => {
  const merged = mergeCopies([
    timed("c0/a", "c0", "Swim", "2026-09-30T13:00:00.000Z"),
    timed("c1/b", "c1", "Swim", "2026-09-30T13:14:00.000Z"),
    timed("c2/c", "c2", "Swim", "2026-09-30T13:28:00.000Z"),
  ]);
  assert.deepEqual(
    merged.map((event) => [event.id, event.calendarKeys]),
    [
      ["c0/a", ["c0", "c1"]],
      ["c2/c", undefined],
    ],
  );
});

test("15 minutes apart merges, 16 does not, and all-day never merges with timed", () => {
  const at15 = mergeCopies([timed("c0/a", "c0", "Swim", "2026-09-30T13:00:00.000Z"), timed("c1/b", "c1", "Swim", "2026-09-30T13:15:00.000Z")]);
  const at16 = mergeCopies([timed("c0/a", "c0", "Swim", "2026-09-30T13:00:00.000Z"), timed("c1/b", "c1", "Swim", "2026-09-30T13:16:00.000Z")]);
  const mixed = mergeCopies([
    { id: "c0/a", title: "PD day", start: "2026-09-30", end: "2026-10-01", allDay: true, calendarKey: "c0" },
    timed("c1/b", "c1", "PD day", "2026-09-30T00:00:00.000Z"),
  ]);
  assert.deepEqual([at15.length, at16.length, mixed.length], [1, 2, 2]);
});

test("different titles stay apart, ties break on calendar then id, and one calendar's copies carry no calendarKeys", () => {
  const apart = mergeCopies([timed("c0/a", "c0", "Swim", "2026-09-30T13:00:00.000Z"), timed("c1/b", "c1", "Swim lesson", "2026-09-30T13:00:00.000Z")]);
  assert.equal(apart.length, 2);
  const tie = mergeCopies([timed("c3/z", "c3", "Swim", "2026-09-30T13:00:00.000Z"), timed("c1/y", "c1", "swim", "2026-09-30T13:00:00.000Z")]);
  assert.deepEqual(tie.map((event) => [event.id, event.title, event.calendarKeys]), [["c1/y", "swim", ["c1", "c3"]]]);
  const sameCalendar = mergeCopies([timed("c0/a", "c0", "Swim", "2026-09-30T13:00:00.000Z"), timed("c0/b", "c0", "Swim", "2026-09-30T13:05:00.000Z")]);
  assert.deepEqual(sameCalendar.map((event) => [event.id, "calendarKeys" in event]), [["c0/a", false]]);
});

test("events keep the order they came in, with a merged event where its earliest copy was", () => {
  const merged = mergeCopies([
    timed("c0/late", "c0", "Swim", "2026-09-30T22:00:00.000Z"),
    timed("c1/copy", "c1", "Dentist", "2026-09-30T15:05:00.000Z"),
    timed("c0/early", "c0", "Bus", "2026-09-30T11:00:00.000Z"),
    timed("c0/first", "c0", "Dentist", "2026-09-30T15:00:00.000Z"),
  ]);
  assert.deepEqual(merged.map((event) => event.id), ["c0/late", "c0/early", "c0/first"]);
});
