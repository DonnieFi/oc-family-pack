import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWireId } from "./calendar-change.ts";
import { reconcile, resolveWriteSource, type IdentityBook, type IdentityEvent } from "./identity.ts";
import { mergeCopies } from "./merge.ts";

const at = "2026-09-30T13:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();

function event(id: string, calendarKey: string, title: string, start: string, extra: IdentityEvent["google"] = {}, fields: Partial<IdentityEvent> = {}): IdentityEvent {
  return {
    id: `${calendarKey}/${id}`,
    title,
    start,
    end: later(60),
    allDay: false,
    calendarKey,
    ...(Object.keys(extra).length > 0 ? { google: { eventId: id, ...extra } } : { google: { eventId: id } }),
    ...fields,
  };
}

const ids = (book: IdentityBook | undefined, events: IdentityEvent[]) =>
  reconcile(events, book).groups.map((group) => [group.fpId, group.copies.map((copy) => copy.id)]);

test("provider identity merges copies and keeps each recurring occurrence distinct", () => {
  const first = reconcile([
    event("a", "c0", "Swim", at, { iCalUID: "swim-uid" }),
    event("b", "c1", "Swim practice", later(40), { iCalUID: "swim-uid" }),
  ]);
  assert.equal(first.groups.length, 1);
  const moved = reconcile([
    event("a", "c0", "Renamed swim", later(90), { iCalUID: "swim-uid" }),
    event("b", "c1", "Renamed swim", later(90), { iCalUID: "swim-uid" }),
  ], { sources: first.patch.sources, overrides: [], legacy: first.patch.legacy });
  assert.equal(moved.groups.length, 1);
  assert.equal(moved.groups[0]!.fpId, first.groups[0]!.fpId);
  const occurrences = reconcile([
    event("a_1", "c0", "Swim", at, { iCalUID: "series", recurringEventId: "series", originalStart: at }),
    event("a_2", "c0", "Swim", later(24 * 60), { iCalUID: "series", recurringEventId: "series", originalStart: later(24 * 60) }),
    event("b_1", "c1", "Swim", at, { iCalUID: "series", recurringEventId: "series", originalStart: at }),
  ]);
  assert.deepEqual(occurrences.groups.map((group) => group.copies.map((copy) => copy.id).sort()), [["c0/a_1", "c1/b_1"], ["c0/a_2"]]);
});

test("different provider ids and same-calendar appointments stay apart, and an uncertain copy stays apart", () => {
  const different = reconcile([
    event("a", "c0", "Swim", at, { iCalUID: "one" }),
    event("b", "c1", "Swim", at, { iCalUID: "two" }),
  ]);
  assert.equal(different.groups.length, 2);
  const sameCalendar = mergeCopies([
    { id: "c0/a", title: "Swim", start: at, end: later(60), allDay: false, calendarKey: "c0" },
    { id: "c0/b", title: "Swim", start: later(5), end: later(60), allDay: false, calendarKey: "c0" },
  ]);
  assert.deepEqual(sameCalendar.map((item) => item.id), ["c0/a", "c0/b"]);
  const uncertain = reconcile([
    event("a", "c0", "Swim", at, { iCalUID: "one" }),
    event("b", "c1", "Swim", at, { iCalUID: "two" }),
    event("c", "c2", "Swim", later(5)),
  ]);
  assert.equal(uncertain.groups.length, 3);
});

test("an imported copy merges across calendars, interleaved matches do not chain, and a hidden source is not projected", () => {
  const imported = reconcile([
    event("a", "c0", "Soccer practice", at),
    { id: "c2/b", title: " soccer   PRACTICE ", start: later(10), end: later(60), allDay: false, calendarKey: "c2" },
    event("d", "c1", "Dentist", later(5)),
    event("e", "c3", "Soccer practice", later(12)),
  ]);
  assert.deepEqual(imported.groups.map((group) => group.copies.map((copy) => copy.id)), [
    ["c0/a", "c2/b", "c3/e"],
    ["c1/d"],
  ]);
  const chained = reconcile([
    event("a", "c0", "Swim", at),
    event("b", "c1", "Swim", later(14)),
    event("c", "c2", "Swim", later(28)),
  ]);
  assert.deepEqual(chained.groups.map((group) => group.copies.map((copy) => copy.id)), [["c0/a", "c1/b"], ["c2/c"]]);
  const saved = reconcile([
    event("a", "c0", "Soccer", at, { iCalUID: "shared" }),
    event("hidden", "c9", "Soccer", at, { iCalUID: "shared" }),
  ]);
  const visible = reconcile([event("a", "c0", "Soccer", at, { iCalUID: "shared" })], {
    sources: saved.patch.sources,
    overrides: [],
    legacy: saved.patch.legacy,
  });
  assert.deepEqual(visible.groups[0]!.copies.map((copy) => copy.calendarKey), ["c0"]);
  assert.equal(visible.groups[0]!.fpId, saved.groups[0]!.fpId);
});

test("a title edit keeps the stored fp-id, a manual merge joins different ids, and a split wins", () => {
  const first = reconcile([event("a", "c0", "Dentist", at), event("b", "c1", "Dentist", later(5))]);
  const book: IdentityBook = { sources: first.patch.sources, overrides: [], legacy: first.patch.legacy };
  const renamed = reconcile([event("a", "c0", "Riley dentist", later(30)), event("b", "c1", "Checkup", later(30))], book);
  assert.equal(renamed.groups.length, 1);
  assert.equal(renamed.groups[0]!.fpId, first.groups[0]!.fpId);
  const apart = reconcile([
    event("a", "c0", "Math", at, { iCalUID: "math" }),
    event("b", "c1", "Art", later(120), { iCalUID: "art" }),
  ]);
  const merged = reconcile(
    [event("a", "c0", "Math", at, { iCalUID: "math" }), event("b", "c1", "Art", later(120), { iCalUID: "art" })],
    { sources: apart.patch.sources, overrides: [{ kind: "merge", sources: [{ calendarKey: "c0", eventId: "a" }, { calendarKey: "c1", eventId: "b" }] }], legacy: apart.patch.legacy },
  );
  assert.equal(merged.groups.length, 1);
  const split = reconcile(
    [event("a", "c0", "Swim", at, { iCalUID: "swim-uid" }), event("b", "c1", "Swim", at, { iCalUID: "swim-uid" })],
    { sources: [], overrides: [{ kind: "split", sources: [{ calendarKey: "c0", eventId: "a" }, { calendarKey: "c1", eventId: "b" }] }], legacy: [] },
  );
  assert.equal(split.groups.length, 2);
});

test("a cancelled copy leaves no stale calendar, and a write resolves to one authorized Google event", () => {
  const both = reconcile([
    event("a", "c0", "Soccer", at, { iCalUID: "shared" }),
    event("b", "c1", "Soccer", at, { iCalUID: "shared" }),
  ]);
  const book: IdentityBook = { sources: both.patch.sources, overrides: [], legacy: both.patch.legacy };
  const remaining = reconcile([event("a", "c0", "Soccer", at, { iCalUID: "shared" })], book);
  assert.equal(remaining.groups.length, 1);
  assert.equal(remaining.groups[0]!.copies.length, 1);
  assert.equal("calendarKeys" in mergeCopies([event("a", "c0", "Soccer", at) as never])[0]!, false);
  const sources = [
    { calendarKey: "c0", eventId: "a" },
    { calendarKey: "c1", eventId: "b" },
  ];
  assert.deepEqual(resolveWriteSource({ calendarKey: "c0", eventId: "a" }, sources, new Set(["c0", "c1"])), { calendarKey: "c0", eventId: "a" });
  assert.deepEqual(resolveWriteSource({ calendarKey: "c9", eventId: "gone" }, sources, new Set(["c1"])), { calendarKey: "c1", eventId: "b" });
  assert.equal(resolveWriteSource({ calendarKey: "c0", eventId: "fp_" + "ab".repeat(16) }, sources, new Set(["c0"])), undefined);
  assert.equal(resolveWriteSource({ calendarKey: "c0", eventId: "a" }, sources, new Set()), undefined);
  const calendars = [{ key: "c0", id: "cal-alex", label: "Alex", kind: "personal" as const, owners: ["alex"] }];
  assert.equal(resolveWireId(calendars, "c0/evt-1")?.eventId, "evt-1");
  assert.equal(resolveWireId(calendars, `c0/${"fp_" + "ab".repeat(16)}`), undefined);
});

test("all-day copies share a date and do not merge with a timed event", () => {
  const day = (id: string, calendarKey: string, start: string): IdentityEvent => ({
    id: `${calendarKey}/${id}`,
    title: "PD day",
    start,
    end: "2026-10-01",
    allDay: true,
    calendarKey,
    google: { eventId: id },
  });
  const grouped = reconcile([day("a", "c0", "2026-09-30"), day("b", "c1", "2026-09-30"), day("c", "c2", "2026-10-01"), event("d", "c3", "PD day", at)]);
  assert.deepEqual(grouped.groups.map((group) => group.copies.map((copy) => copy.id)), [["c0/a", "c1/b"], ["c2/c"], ["c3/d"]]);
});

test("an imported copy merges on either side of its provider copy's start", () => {
  for (const offset of [-5, 5]) {
    assert.equal(reconcile([
      event("import", "c0", "Math", later(offset)),
      event("provider", "c1", "Math", at, { iCalUID: "math-uid" }),
    ]).groups.length, 1);
  }
});
