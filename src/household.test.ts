import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSchoolLines,
  clockFromMinutes,
  dayIsClosed,
  dueHousehold,
  householdMessage,
  inclusiveDays,
  morningLines,
  sundayOnOrAfter,
  weekendLines,
  type HouseholdItem,
} from "./household.ts";
import { localTime } from "./week.ts";

const TZ = "America/Halifax";
const WED = "2026-10-14";
const FRI = "2026-10-16";
const at = (date: string, hours: number, minutes = 0) => localTime(date, hours, TZ) + minutes * 60_000;

function item(partial: Partial<HouseholdItem> & Pick<HouseholdItem, "title" | "date">): HouseholdItem {
  return {
    id: partial.id ?? `c0/${partial.title.toLowerCase().replaceAll(" ", "-")}`,
    title: partial.title,
    date: partial.date,
    allDay: partial.allDay ?? false,
    owners: partial.owners ?? [],
    section: partial.section ?? "not the usual",
    ...(partial.minutes === undefined ? {} : { minutes: partial.minutes }),
    ...(partial.endMinutes === undefined ? {} : { endMinutes: partial.endMinutes }),
    ...(partial.location === undefined ? {} : { location: partial.location }),
  };
}

const TIMES = { timezone: TZ, morningTime: "07:00", afterSchoolTime: "15:30", weekendPreviewTime: "16:00" };

test("windows follow the configured clock, weekdays only, and Friday when no preview day is set", () => {
  assert.deepEqual(dueHousehold(at(WED, 6, 59), TIMES).map((job) => job.kind), []);
  assert.deepEqual(dueHousehold(at(WED, 7), TIMES).map((job) => job.kind), ["morning"]);
  assert.deepEqual(dueHousehold(at(WED, 11, 59), TIMES).map((job) => job.kind), ["morning"]);
  assert.deepEqual(dueHousehold(at(WED, 12), TIMES).map((job) => job.kind), []);
  assert.deepEqual(dueHousehold(at(WED, 15, 30), TIMES).map((job) => job.kind), ["after-school"]);
  assert.deepEqual(dueHousehold(at(WED, 20, 30), TIMES).map((job) => job.kind), []);
  assert.deepEqual(dueHousehold(at("2026-10-17", 7), TIMES).map((job) => job.kind), []);
  assert.deepEqual(dueHousehold(at(FRI, 20, 30), TIMES).map((job) => job.kind), ["weekend"]);
  assert.deepEqual(dueHousehold(at(WED, 20, 30), { ...TIMES, weekendPreviewWeekday: 3 }).map((job) => job.kind), ["weekend"]);
  assert.equal(dueHousehold(at(WED, 7), { timezone: TZ }).length, 0);
  assert.equal(sundayOnOrAfter(FRI), "2026-10-18");
  assert.equal(inclusiveDays(FRI, "2026-10-18"), 3);
});

test("morning keeps today's items and tomorrow's actionable ones, and skips work meetings and school phrases", () => {
  const lines = morningLines(
    [
      item({ title: "Sprint standup", date: WED, minutes: 10 * 60, owners: ["Alex"] }),
      item({ title: "Dentist", date: WED, minutes: 9 * 60, owners: ["Alex"] }),
      item({ title: "Field trip", date: WED, minutes: 13 * 60 }),
      item({ title: "Playdate", date: "2026-10-15", minutes: 15 * 60 }),
      item({ title: "Tax appointment", date: "2026-10-15", minutes: 11 * 60, owners: ["Sam"] }),
      item({ title: "Insurance renewal", date: WED, allDay: true }),
    ],
    WED,
    ["field trip"],
  );
  assert.deepEqual(lines, ["Today all day: Insurance renewal", "Today 9:00 AM: Dentist (Alex)", "Tomorrow 11:00 AM: Tax appointment (Sam)"]);
  assert.equal(lines.join("\n").includes("c0/"), false);
});

test("after school stays quiet for a usual day or a closed day, and posts an afternoon exception with a pack list", () => {
  const soccer = item({ title: "Soccer practice", date: WED, minutes: 16 * 60, section: "uniforms" });
  assert.equal(afterSchoolLines([], WED, false, "Usual: Soccer 4:00 PM"), undefined);
  const game = item({ title: "Soccer game", date: WED, minutes: 16 * 60, owners: ["Riley"] });
  const form = item({ title: "Permission form", date: WED, minutes: 9 * 60 });
  assert.deepEqual(afterSchoolLines([game, form, soccer], WED, false, "Usual: Practice 4:00 PM"), [
    "4:00 PM — Soccer game (Riley)",
    "Pack: forms, uniforms",
    "Usual: Practice 4:00 PM",
  ]);
  assert.equal(afterSchoolLines([game], WED, true), undefined);
  assert.equal(dayIsClosed(["No school"], ["no school"]), true);
  assert.equal(dayIsClosed(["No school"], []), false);
});

test("a quiet weekend is one line, and a place adds a leave-by hint without an event id", () => {
  assert.deepEqual(weekendLines([], FRI, "2026-10-18"), ["Quiet weekend: nothing major on the calendar."]);
  const game = item({ title: "Soccer game", date: "2026-10-17", minutes: 10 * 60, endMinutes: 11 * 60, location: "Field", owners: ["Riley"] });
  const practice = item({ title: "Piano", date: "2026-10-17", minutes: 10 * 60 + 30, endMinutes: 11 * 60 });
  const lines = weekendLines([game, practice], FRI, "2026-10-18");
  assert.equal(lines[0], "Sat 10:00 AM — Soccer game (Riley) @ Field — leave by ~9:30 AM");
  assert.ok(lines.some((line) => line.startsWith("Conflict Sat:")));
  assert.equal(lines.join("\n").includes("evt"), false);
  assert.equal(clockFromMinutes(-30), "11:30 PM");
});

test("the household embed is the lines and nothing else", () => {
  const message = householdMessage("Morning", ["Today 9:00 AM: Dentist"]);
  assert.equal(message.text, undefined);
  assert.equal(message.embed?.title, "Morning");
  assert.equal(message.embed?.description, "Today 9:00 AM: Dentist");
  assert.equal(message.embed?.footer, undefined);
});
