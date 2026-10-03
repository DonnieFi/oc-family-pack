import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEvent, DEFAULT_VOCABULARY, usualLine, type ClassifyInput } from "./classify.ts";

const at = (start: string, fields: Partial<ClassifyInput> = {}): ClassifyInput => ({
  title: "Event",
  start,
  end: start,
  allDay: false,
  calendarKind: "personal",
  ...fields,
});
const timed = (title: string, calendarKind: ClassifyInput["calendarKind"], fields: Partial<ClassifyInput> = {}) =>
  at("2026-09-30T21:30:00.000Z", { title, calendarKind, end: "2026-09-30T22:30:00.000Z", ...fields });
const day = (title: string, calendarKind: ClassifyInput["calendarKind"], fields: Partial<ClassifyInput> = {}) =>
  at("2026-09-28", { title, calendarKind, end: "2026-10-03", allDay: true, ...fields });
const series = { recurringEventId: "series1" };

// Each row is what Bernie's school_calendar.py (is_routine, homework_due_events, uniform_notes) does with the same event.
const cases: [string, ClassifyInput, ReturnType<typeof classifyEvent>][] = [
  ["a school class is routine", timed("Grade 4 French", "school"), { routine: true }],
  ["a test is never routine, even at school", timed("Math test", "school"), { routine: false }],
  ["a timed school row is never a uniform", timed("Spirit day assembly", "school"), { routine: true }],
  ["an all-day school row is homework due the day before its exclusive end", day("Read chapter 3", "school"), { routine: true, homework: { dueDate: "2026-10-02" } }],
  ["an all-day school signal is still homework, but not routine", day("Science quiz", "school"), { routine: false, homework: { dueDate: "2026-10-02" } }],
  ["a plain PE uniform is routine", day("PE uniform", "school"), { routine: true, uniform: { dueDate: "2026-10-02" } }],
  ["spirit gear is routine", day("spirit  gear", "school"), { routine: true, uniform: { dueDate: "2026-10-02" } }],
  ["a bare uniform is routine", day(" Uniform ", "school"), { routine: true, uniform: { dueDate: "2026-10-02" } }],
  ["a special dress day is a uniform, not routine", day("Pajama dress-up day", "school"), { routine: false, uniform: { dueDate: "2026-10-02" } }],
  ["P.E. with dots is a uniform", day("P.E. gear", "school"), { routine: true, uniform: { dueDate: "2026-10-02" } }],
  ["a family all-day event is never homework or routine", day("Read chapter 3", "shared", series), { routine: false }],
  ["an on-time repeat of a timed family event is routine", timed("Soccer practice", "personal", series), { routine: true }],
  ["a repeat still in its slot is routine", timed("Soccer practice", "shared", { ...series, originalStart: "2026-09-30T21:30:00.000Z" }), { routine: true }],
  ["a moved repeat is not routine", timed("Soccer practice", "personal", { ...series, originalStart: "2026-09-30T20:30:00.000Z" }), { routine: false }],
  ["a one-off is not routine", timed("Soccer practice", "personal"), { routine: false }],
  ["an appointment never is, even repeating", timed("Dentist", "personal", series), { routine: false }],
  ["Dr as a word is an appointment", timed("Dr. Patel", "personal", series), { routine: false }],
  ["dr inside a word is not", timed("Drama club", "shared", series), { routine: true }],
  ["a birthday never is", timed("Sam's birthday dinner", "shared", series), { routine: false }],
];

for (const [name, input, expected] of cases) {
  test(name, () => assert.deepEqual(classifyEvent(input), expected));
}

test("the vocabulary can be swapped for another region's words", () => {
  const vocabulary = { ...DEFAULT_VOCABULARY, alwaysSignal: /\bjour pédagogique\b/i };
  assert.deepEqual(classifyEvent(timed("Math test", "school"), vocabulary), { routine: true });
  assert.deepEqual(classifyEvent(timed("Jour pédagogique", "school"), vocabulary), { routine: false });
  // A signal word wins even over a plain-uniform pattern.
  const spirit = { ...DEFAULT_VOCABULARY, alwaysSignal: /\bspirit\b/i };
  assert.deepEqual(classifyEvent(day("Spirit gear", "school"), spirit), { routine: false, uniform: { dueDate: "2026-10-02" } });
});

test("the usual line lists routine timed family events by start, in the family's timezone", () => {
  const line = usualLine(
    [
      timed("Swim", "shared", { ...series, start: "2026-09-30T21:30:00.000Z" }),
      timed("Grade 4 French", "school", { start: "2026-09-30T12:00:00.000Z" }),
      timed("Bus", "personal", { ...series, start: "2026-09-30T11:05:00.000Z" }),
      timed("Lunch walk", "personal", { ...series, start: "2026-09-30T15:00:00.000Z" }),
      timed("Dentist", "personal", { ...series, start: "2026-09-30T13:00:00.000Z" }),
      timed("Moved piano", "personal", { ...series, start: "2026-09-30T19:00:00.000Z", originalStart: "2026-09-30T18:00:00.000Z" }),
      timed("Late call", "personal", { ...series, start: "2026-10-01T03:00:00.000Z" }),
      day("Uniform", "school"),
    ],
    "America/Halifax",
  );
  assert.equal(line, "Usual: Bus 8:05 AM · Lunch walk 12:00 PM · Swim 6:30 PM · Late call 12:00 AM");
});

test("no routine timed family event means no usual line", () => {
  assert.equal(usualLine([timed("Grade 4 French", "school"), timed("Soccer practice", "personal")], "America/Halifax"), undefined);
});
