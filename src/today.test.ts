import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { RunGog } from "./calendar-gog.ts";
import { parseConfig } from "./config.ts";
import { TodayPayloadSchema } from "./contract.ts";
import { GARBAGE_TOMORROW, QUIET_DAY } from "./highlights.ts";
import { familyHandlers } from "./handlers.ts";
import type { TodayPayload } from "./types.ts";

const TZ = "America/Toronto";
/** Tuesday Sept 29, 2026, 8:00 AM in Toronto. Dentist is 9:30 AM on the demo week. */
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

const tool = (fields: Record<string, unknown>) => ({ source: "tool", api: {}, toolCallId: "call-1", tool: fields }) as never;

test("demo mode highlights come from the demo week, and a guest does not see someone else's calendar", async () => {
  const handlers = familyHandlers(parseConfig({ demo: true, timezone: TZ }), { now: () => NOW });
  const owner = await handlers["family.today"]({}, tool({ senderIsOwner: true }));
  const expected: TodayPayload = {
    date: "2026-09-29",
    highlights: ["⏰ Dentist in 90 min"],
    exceptions: [
      {
        id: "demo/t2",
        title: "Dentist",
        start: "2026-09-29T13:30:00.000Z",
        end: "2026-09-29T14:30:00.000Z",
        allDay: false,
        location: "Family Dental",
        calendarKey: "c0",
        ownerIds: ["alex"],
      },
      {
        id: "demo/t3",
        title: "Piano lesson",
        start: "2026-09-29T20:30:00.000Z",
        end: "2026-09-29T21:30:00.000Z",
        allDay: false,
        location: "Music Studio",
        calendarKey: "c3",
        ownerIds: ["jordan"],
      },
    ],
  };
  assert.deepEqual(owner, expected);
  assert.equal(Value.Check(TodayPayloadSchema, owner), true);
  assert.deepEqual(await handlers["family.today"]({}, tool({ messageChannel: "discord", requesterSenderId: "200000000000000099" })), {
    date: "2026-09-29",
    highlights: [QUIET_DAY],
    exceptions: [],
  });
});

test("garbage tomorrow is a highlight only when a collection calendar is configured and tomorrow has a pickup", async () => {
  const url = "https://calendar.example/collection.ics";
  const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260930\nSUMMARY:Garbage\nEND:VEVENT\nEND:VCALENDAR\n";
  const withFeed = familyHandlers(parseConfig({ demo: true, timezone: TZ, garbageIcsUrl: url }), {
    now: () => NOW,
    fetchGarbage: async () => new Response(ics, { status: 200 }),
  });
  const today = await withFeed["family.today"]({}, tool({ senderIsOwner: true }));
  assert.deepEqual(today.highlights, ["⏰ Dentist in 90 min", GARBAGE_TOMORROW]);
  const unset = familyHandlers(parseConfig({ demo: true, timezone: TZ }), { now: () => NOW });
  assert.deepEqual((await unset["family.today"]({}, tool({ senderIsOwner: true }))).highlights, ["⏰ Dentist in 90 min"]);
});

test("a live read scores the school class separately and stays inside the calendars the caller can see", async () => {
  const runGog: RunGog = async (_file, args) => {
    const id = args.at(-1);
    const events =
      id === "school-riley"
        ? [{ id: "math", summary: "Math", start: { dateTime: "2026-10-09T08:30:00-04:00" }, end: { dateTime: "2026-10-09T09:20:00-04:00" } }]
        : id === "alex"
          ? [{ id: "dentist", summary: "Dentist", start: { dateTime: "2026-10-09T09:30:00-04:00" }, end: { dateTime: "2026-10-09T10:30:00-04:00" } }]
          : [];
    return { stdout: JSON.stringify({ events }) };
  };
  const config = parseConfig({
    timezone: TZ,
    gogPath: "/fake/gog",
    members: [
      { profileId: "alex", displayName: "Alex", role: "parent" },
      { profileId: "riley", displayName: "Riley", role: "kid" },
    ],
    calendars: [
      { id: "alex", label: "Alex", kind: "personal", owners: ["alex"] },
      { id: "school-riley", label: "School", kind: "school", owners: ["riley"] },
    ],
  });
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const handlers = familyHandlers(config, { now: () => now, runGog });
  const owner = await handlers["family.today"]({}, tool({ senderIsOwner: true }));
  assert.deepEqual(owner.highlights, ["⏰ Dentist in 90 min", "🏫 Math · 8:30 AM"]);
  assert.deepEqual(owner.exceptions, [
    {
      id: "c0/dentist",
      title: "Dentist",
      start: "2026-10-09T13:30:00.000Z",
      end: "2026-10-09T14:30:00.000Z",
      allDay: false,
      calendarKey: "c0",
      ownerIds: ["alex"],
    },
  ]);
  const guest = await handlers["family.today"]({}, tool({ messageChannel: "discord", requesterSenderId: "200000000000000099" }));
  assert.deepEqual(guest, { date: "2026-10-09", highlights: [QUIET_DAY], exceptions: [] });
  const text = JSON.stringify(owner);
  assert.equal(text.includes("school-riley"), false);
  assert.equal(text.includes("@"), false);
});

test("the family skill states the caller rules, the tools, and that undo is not shipped", () => {
  const skill = readFileSync(new URL("../skills/family/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /family_today/);
  assert.match(skill, /family_schedule/);
  assert.match(skill, /garbage_schedule/);
  assert.match(skill, /I can't tell who 'me' is here\. Name the person\./);
  assert.match(skill, /Undo is not available yet/);
  assert.equal(skill.includes("@"), false);
});
