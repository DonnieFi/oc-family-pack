import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { RunGog } from "./calendar-gog.ts";
import { GOG_SETUP_HINT } from "./calendar-gog.ts";
import { parseConfig } from "./config.ts";
import { ScheduleOutputSchema } from "./contract.ts";
import { familyHandlers } from "./handlers.ts";
import { fitsHostLimits, jsonNodeCount } from "./payload.ts";
import { buildSchedule, ME_UNKNOWN, NO_MATCH, NOTHING_ON, scheduleCaller, type ScheduleCaller } from "./schedule.ts";
import type { ScheduleOutput } from "./types.ts";

const TZ = "America/Toronto";
/** Friday Oct 9, 2026, mid-afternoon in Toronto. */
const NOW = Date.parse("2026-10-09T18:00:00Z");
const CALLA_DISCORD = "100000000000000001";
const DONNIE_DISCORD = "100000000000000003";
const OWNER: ScheduleCaller = { viewer: { kind: "owner" } };
const GUEST: ScheduleCaller = { viewer: { kind: "person", username: undefined } };
const CALLA: ScheduleCaller = { viewer: { kind: "person", username: "calla" }, me: "calla" };

type Raw = Record<string, unknown>;
const at = (date: string, clock: string) => ({ dateTime: `${date}T${clock}:00-04:00` });
const timed = (id: string, summary: string, date: string, from: string, to: string, extra: Raw = {}): Raw => ({
  id,
  summary,
  start: at(date, from),
  end: at(date, to),
  ...extra,
});
const allDay = (id: string, summary: string, from: string, to: string): Raw => ({ id, summary, start: { date: from }, end: { date: to } });
const swim = (date: string, calendar: string): Raw =>
  timed(`swim-${calendar}-${date}`, "Swim", date, "17:00", "18:00", {
    recurringEventId: `swim-${calendar}`,
    originalStartTime: at(date, "17:00"),
  });

const EVENTS: Record<string, Raw[]> = {
  donnie: [timed("dentist", "Dentist", "2026-10-09", "09:30", "10:30")],
  calla: [swim("2026-10-09", "calla"), swim("2026-10-10", "calla")],
  family: [
    timed("dinner", "Family dinner", "2026-10-09", "18:00", "19:00"),
    allDay("pe-f", "PE uniform", "2026-10-09", "2026-10-10"),
    swim("2026-10-09", "family"),
    swim("2026-10-10", "family"),
    timed("cafe", "Café social", "2026-10-09", "13:00", "14:00"),
    timed("zoe", "Zoë's recital", "2026-10-10", "15:00", "16:00"),
  ],
  "school-calla": [
    timed("math", "Math", "2026-10-09", "08:30", "09:20"),
    timed("gym", "Gym", "2026-10-09", "10:15", "11:00"),
    timed("test", "Math test", "2026-10-09", "11:00", "12:00"),
    timed("math2", "Math", "2026-10-10", "08:30", "09:20"),
    allDay("project", "Science project", "2026-10-08", "2026-10-10"),
    allDay("pe-s", "PE uniform", "2026-10-09", "2026-10-10"),
  ],
  "school-penny": [timed("art", "Art", "2026-10-09", "09:00", "09:45")],
  house: [timed("furnace", "Furnace service", "2026-10-09", "12:00", "13:00")],
};

function household(events: Record<string, Raw[]> = EVENTS, extra: Raw = {}) {
  const config = parseConfig({
    timezone: TZ,
    gogPath: "/fake/gog",
    members: [
      { profileId: "donnie", displayName: "Donnie", role: "parent", discordId: DONNIE_DISCORD },
      { profileId: "britta", displayName: "Britta", role: "parent" },
      { profileId: "calla", displayName: "Calla", role: "kid", discordId: CALLA_DISCORD },
      { profileId: "penny", displayName: "Penny", role: "kid" },
    ],
    calendars: [
      { id: "donnie", label: "Donnie", kind: "personal", owners: ["donnie"] },
      { id: "calla", label: "Calla", kind: "personal", owners: ["calla"] },
      { id: "family", label: "Family", kind: "shared", owners: ["donnie", "britta", "calla", "penny"] },
      { id: "school-calla", label: "Calla school", kind: "school", owners: ["calla"] },
      { id: "school-penny", label: "Penny school", kind: "school", owners: ["penny"] },
      { id: "house", label: "House", kind: "personal", owners: [] },
    ],
    ...extra,
  });
  const read: string[] = [];
  const runGog: RunGog = async (_file, args) => {
    const id = args.at(-1) ?? "";
    read.push(id);
    return { stdout: JSON.stringify({ events: events[id] ?? [] }) };
  };
  return { config, runGog, read };
}

async function schedule(input: Parameters<typeof buildSchedule>[1], caller: ScheduleCaller = OWNER, events?: Record<string, Raw[]>) {
  const { config, runGog, read } = household(events);
  const output = await buildSchedule(config, input, caller, NOW, runGog);
  assert.ok(Value.Check(ScheduleOutputSchema, output), JSON.stringify([...Value.Errors(ScheduleOutputSchema, output)].slice(0, 3)));
  return { output, read };
}

const titles = (output: ScheduleOutput) => ("sections" in output ? output.sections.flatMap((section) => section.items.map((item) => item.title)) : []);
const tool = (tool: Raw) => ({ source: "tool", api: {}, toolCallId: "call-1", tool }) as never;

const FRIDAY: ScheduleOutput = {
  sections: [
    {
      name: "not the usual",
      items: [
        { id: "c0/dentist", title: "Dentist", time: "9:30 AM", owners: ["Donnie"] },
        { id: "c3/test", title: "Math test", time: "11:00 AM", owners: ["Calla"] },
        { id: "c5/furnace", title: "Furnace service", time: "12:00 PM", owners: [] },
        { id: "c2/cafe", title: "Café social", time: "1:00 PM", owners: ["Donnie", "Britta", "Calla", "Penny"] },
        { id: "c2/dinner", title: "Family dinner", time: "6:00 PM", owners: ["Donnie", "Britta", "Calla", "Penny"] },
      ],
    },
    { name: "homework", items: [{ id: "c3/project", title: "Science project", allDay: true, due: "Fri Oct 9", owners: ["Calla"] }] },
    { name: "uniforms", items: [{ id: "c2/pe-f", title: "PE uniform", allDay: true, due: "Fri Oct 9", owners: ["Donnie", "Britta", "Calla", "Penny"] }] },
  ],
  classes: [{ line: "Calla: Math 8:30 AM · Gym 10:15 AM" }, { line: "Penny: Art 9:00 AM" }],
  usual: "Usual: Swim 5:00 PM",
};

test("a day reads as not the usual, homework, uniforms, classes, then the usual line", async () => {
  const { output } = await schedule({ start: "2026-10-09" });
  assert.deepEqual(output, FRIDAY);
});

test("start defaults to today in the family's timezone, not UTC", async () => {
  const { config, runGog } = household();
  // 11:30 PM Friday in Toronto is already Saturday in UTC.
  const output = await buildSchedule(config, {}, OWNER, Date.parse("2026-10-10T03:30:00Z"), runGog);
  assert.deepEqual(output, FRIDAY);
});

test("each event appears once, even when copies sit on two calendars", async () => {
  const { output } = await schedule({ start: "2026-10-09" });
  const wire = JSON.stringify(output);
  for (const title of ["PE uniform", "Swim", "Math test", "Dentist"]) {
    assert.equal(wire.split(title).length - 1, 1, title);
  }
});

test("a merged event takes the earliest section in precedence: homework, uniforms, not the usual, usual", async () => {
  // PE uniform is a uniform on the school calendar and an all-day one-off on the family calendar.
  const { output } = await schedule({ start: "2026-10-09" });
  assert.ok("sections" in output);
  assert.deepEqual(
    output.sections.map((section) => [section.name, section.items.some((item) => item.title === "PE uniform")]),
    [
      ["not the usual", false],
      ["homework", false],
      ["uniforms", true],
    ],
  );
  const homework = await schedule({ start: "2026-10-09" }, OWNER, {
    family: [allDay("p1", "Science project", "2026-10-09", "2026-10-10")],
    "school-calla": [allDay("p2", "Science project", "2026-10-09", "2026-10-10")],
  });
  assert.deepEqual(homework.output, {
    sections: [{ name: "homework", items: [{ id: "c2/p1", title: "Science project", allDay: true, due: "Fri Oct 9", owners: ["Donnie", "Britta", "Calla", "Penny"] }] }],
  });
});

test("member keeps shared calendars and that person's own, and drops everyone else's and ownerless private ones", async () => {
  const { output } = await schedule({ start: "2026-10-09", member: "calla" });
  assert.deepEqual(titles(output), ["Math test", "Café social", "Family dinner", "Science project", "PE uniform"]);
  assert.ok("sections" in output);
  assert.deepEqual(output.classes, [{ line: "Math 8:30 AM · Gym 10:15 AM" }]);
  assert.equal(output.usual, "Usual: Swim 5:00 PM");
});

test("visibility runs before member: a kid naming someone else gets shared calendars only", async () => {
  const { output, read } = await schedule({ start: "2026-10-09", member: "penny" }, CALLA);
  assert.deepEqual(titles(output), ["PE uniform", "Café social", "Family dinner"]);
  assert.equal(JSON.stringify(output).includes("Art"), false);
  assert.deepEqual(read, ["family"]);
  const parent = await schedule({ start: "2026-10-09", member: "donnie" }, CALLA);
  assert.equal(JSON.stringify(parent.output).includes("Dentist"), false);
});

test("a guest sees shared calendars only and reads nothing else", async () => {
  const { output, read } = await schedule({ start: "2026-10-09" }, GUEST);
  assert.deepEqual(titles(output), ["PE uniform", "Café social", "Family dinner"]);
  assert.deepEqual(read, ["family"]);
});

test("the caller comes from the tool context: Discord roster match or guest, owner flag only off Discord", () => {
  const { config } = household();
  const members = config.members;
  const guest = { viewer: { kind: "person", username: undefined } };
  assert.deepEqual(scheduleCaller(members, { source: "session-action", api: {}, action: {} } as never), guest);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "discord", requesterSenderId: CALLA_DISCORD })), CALLA);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "discord", requesterSenderId: "199999999999999999", senderIsOwner: true })), guest);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "discord", requesterSenderId: CALLA_DISCORD.slice(0, -1), senderIsOwner: true })), guest);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "discord", senderIsOwner: true })), guest);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "telegram", senderIsOwner: true })), OWNER);
  assert.deepEqual(scheduleCaller(members, tool({ messageChannel: "telegram", requesterSenderId: CALLA_DISCORD })), guest);
});

test("me needs a Discord roster match; anything else is the error and no data", async () => {
  const { config } = household();
  for (const caller of [OWNER, GUEST, scheduleCaller(config.members, tool({ messageChannel: "telegram", requesterSenderId: CALLA_DISCORD, senderIsOwner: true }))]) {
    const { output, read } = await schedule({ start: "2026-10-09", member: "me" }, caller);
    assert.deepEqual(output, { error: ME_UNKNOWN });
    assert.deepEqual(read, []);
  }
  const mine = await schedule({ start: "2026-10-09", member: "me" }, CALLA);
  const named = await schedule({ start: "2026-10-09", member: "calla" }, CALLA);
  assert.deepEqual(mine.output, named.output);
});

test("an unknown member is an error", async () => {
  const { output } = await schedule({ member: "mallory" });
  assert.ok("error" in output);
});

test("days: 7 without a query, 90 with one", async () => {
  assert.ok("sections" in (await schedule({ start: "2026-10-09", days: 7 })).output);
  assert.ok("error" in (await schedule({ start: "2026-10-09", days: 8 })).output);
  assert.ok("sections" in (await schedule({ start: "2026-10-09", days: 90, query: "swim" })).output);
  assert.ok("error" in (await schedule({ start: "2026-10-09", days: 91, query: "swim" })).output);
});

test("a query with no days looks 90 days ahead, and an explicit days still wins", async () => {
  const events = { ...EVENTS, donnie: [...(EVENTS.donnie ?? []), timed("dentist-nov", "Dentist", "2026-11-08", "09:30", "10:30"), timed("dentist-day-90", "Dentist", "2027-01-06", "09:30", "10:30"), timed("dentist-day-91", "Dentist", "2027-01-07", "09:30", "10:30")] };
  const { output } = await schedule({ query: "dentist" }, OWNER, events);
  assert.deepEqual(
    "sections" in output ? output.sections[0]?.items.map((item) => item.date) : output,
    ["Fri Oct 9", "Sun Nov 8", "Wed Jan 6"],
  );
  assert.deepEqual(titles((await schedule({ query: "dentist", days: 1 }, OWNER, events)).output), ["Dentist"]);
});

test("a query that normalizes to empty is no query and keeps the week cap", async () => {
  assert.ok("error" in (await schedule({ start: "2026-10-09", days: 8, query: "   " })).output);
  assert.ok("error" in (await schedule({ start: "2026-10-09", days: 8, query: " - " })).output);
  assert.deepEqual((await schedule({ start: "2026-10-09", query: "   " })).output, FRIDAY);
});

test("a query lists whole-word title matches in one section sorted by start", async () => {
  const { output } = await schedule({ start: "2026-10-09", days: 2, query: "  SWIM " });
  assert.deepEqual(output, {
    sections: [
      {
        name: "matches",
        items: [
          { id: "c1/swim-calla-2026-10-09", title: "Swim", time: "5:00 PM", date: "Fri Oct 9", owners: ["Donnie", "Britta", "Calla", "Penny"] },
          { id: "c1/swim-calla-2026-10-10", title: "Swim", time: "5:00 PM", date: "Sat Oct 10", owners: ["Donnie", "Britta", "Calla", "Penny"] },
        ],
      },
    ],
  });
  assert.deepEqual(titles((await schedule({ start: "2026-10-09", query: "dinner family" })).output), ["Family dinner"]);
});

test("a query word that is only part of a title word matches nothing, Unicode included", async () => {
  const day = { start: "2026-10-09", days: 2 };
  assert.deepEqual((await schedule({ ...day, query: "dent" })).output, { note: NO_MATCH });
  assert.deepEqual((await schedule({ ...day, query: "caf" })).output, { note: NO_MATCH });
  assert.deepEqual((await schedule({ ...day, query: "zo" })).output, { note: NO_MATCH });
  assert.deepEqual(titles((await schedule({ ...day, query: "café" })).output), ["Café social"]);
  assert.deepEqual(titles((await schedule({ ...day, query: "Zoë" })).output), ["Zoë's recital"]);
});

test("a match on a calendar the viewer can't see is the no-match line", async () => {
  assert.deepEqual((await schedule({ start: "2026-10-09", query: "dentist" }, GUEST)).output, { note: NO_MATCH });
  assert.deepEqual(titles((await schedule({ start: "2026-10-09", query: "dentist" })).output), ["Dentist"]);
});

test("a range longer than a day dates items and classes, and lists a usual repeat once", async () => {
  const { output } = await schedule({ start: "2026-10-09", days: 2 });
  assert.ok("sections" in output);
  assert.equal(output.usual, "Usual: Swim 5:00 PM");
  assert.deepEqual(output.classes, [
    { date: "Fri Oct 9", line: "Calla: Math 8:30 AM · Gym 10:15 AM" },
    { date: "Fri Oct 9", line: "Penny: Art 9:00 AM" },
    { date: "Sat Oct 10", line: "Calla: Math 8:30 AM" },
  ]);
  assert.ok(output.sections.every((section) => section.items.every((item) => item.date !== undefined)));
});

test("an empty day is one line", async () => {
  assert.deepEqual((await schedule({ start: "2026-10-12" })).output, { note: NOTHING_ON });
});

test("calendar read problems come back as the error alone", async () => {
  const empty = household({}, { calendars: [] });
  const unset = await buildSchedule(empty.config, {}, OWNER, NOW, empty.runGog);
  assert.ok("error" in unset && unset.error.endsWith(GOG_SETUP_HINT), JSON.stringify(unset));
  const { config } = household();
  const broken: RunGog = async () => {
    throw Object.assign(new Error("boom"), { stderr: "boom" });
  };
  const output = await buildSchedule(config, {}, OWNER, NOW, broken);
  assert.deepEqual(Object.keys(output), ["error"]);
  assert.ok("error" in output && output.error.includes('Could not read the "Family" calendar'));
  const { runGog } = household();
  const flaky: RunGog = (file, args) => (args.at(-1) === "house" ? broken(file, args) : runGog(file, args));
  const partial = await buildSchedule(config, { start: "2026-10-09" }, OWNER, NOW, flaky);
  assert.ok("sections" in partial);
  assert.deepEqual(partial.warnings, ['Could not read the "House" calendar: gog error code 1']);
  assert.equal(titles(partial).includes("Furnace service"), false);
});

test("more than 40 items lists 40 in section order, then +N more", async () => {
  const many = Array.from({ length: 45 }, (_, i) => timed(`e${i}`, `Errand ${i}`, "2026-10-09", "12:00", "12:30"));
  const { output } = await schedule({ start: "2026-10-09" }, OWNER, { family: many, "school-calla": [allDay("hw", "Book report", "2026-10-09", "2026-10-10")] });
  assert.ok("sections" in output);
  assert.deepEqual(
    output.sections.map((section) => [section.name, section.items.length]),
    [["not the usual", 40]],
  );
  assert.equal(output.more, "+6 more");
});

test("at the cap with 32 owners on every item the result stays inside the host limits", async () => {
  const members = Array.from({ length: 32 }, (_, i) => ({ profileId: `m${i}`, displayName: `Member ${i}`, role: "parent" }));
  const config = parseConfig({
    timezone: TZ,
    gogPath: "/fake/gog",
    members,
    calendars: [{ id: "family", label: "Family", kind: "shared", owners: members.map((member) => member.profileId) }],
  });
  const many = Array.from({ length: 41 }, (_, i) => timed(`e${i}`, `Errand ${i}`, "2026-10-09", "12:00", "12:30"));
  const runGog: RunGog = async () => ({ stdout: JSON.stringify({ events: many }) });
  const output = await buildSchedule(config, { start: "2026-10-09" }, OWNER, NOW, runGog);
  assert.ok("sections" in output);
  assert.equal(output.sections[0]?.items.length, 40);
  assert.equal(output.sections[0]?.items[0]?.owners.length, 32);
  const nodes = jsonNodeCount(output);
  assert.ok(nodes < 4096, `${nodes} nodes`);

  // Long names and titles pass the byte limit before the item cap, so items drop into +N more.
  const long = parseConfig({
    timezone: TZ,
    gogPath: "/fake/gog",
    members: members.map((member, i) => ({ ...member, displayName: `${String(i).padStart(2, "0")}${"n".repeat(198)}` })),
    calendars: [{ id: "family", label: "Family", kind: "shared", owners: members.map((member) => member.profileId) }],
  });
  const wordy: RunGog = async () => ({ stdout: JSON.stringify({ events: many.map((event, i) => ({ ...event, summary: `${i} ${"t".repeat(490)}` })) }) });
  const big = await buildSchedule(long, { start: "2026-10-09" }, OWNER, NOW, wordy);
  assert.ok("sections" in big);
  assert.ok(fitsHostLimits(big));
  const kept = big.sections[0]?.items.length ?? 0;
  assert.ok(kept < 40);
  assert.equal(big.more, `+${41 - kept} more`);
});

test("demo mode answers from the demo calendars", async () => {
  const config = parseConfig({ demo: true, timezone: TZ });
  const output = await buildSchedule(config, { start: "2026-10-01", days: 7 }, OWNER, NOW);
  assert.ok(Value.Check(ScheduleOutputSchema, output));
  assert.ok(titles(output).includes("Dentist"));
});

test("the family.schedule handler reads the caller from the tool context", async () => {
  const { config, runGog } = household();
  const handlers = familyHandlers(config, { now: () => NOW, runGog });
  const output = await handlers["family.schedule"]({ member: "me" }, tool({ messageChannel: "discord", requesterSenderId: CALLA_DISCORD }));
  assert.deepEqual(titles(output), ["Math test", "Café social", "Family dinner", "Science project", "PE uniform"]);
  assert.deepEqual(await handlers["family.schedule"]({ member: "me" }, tool({ messageChannel: "discord", requesterSenderId: DONNIE_DISCORD.slice(1) })), {
    error: ME_UNKNOWN,
  });
});

test("a viewer who can see none of the calendars gets the empty line and nothing is read", async () => {
  const { config, runGog, read } = household(EVENTS, {
    calendars: [{ id: "donnie", label: "Donnie", kind: "personal", owners: ["donnie"] }],
  });
  assert.deepEqual(await buildSchedule(config, { start: "2026-10-09" }, GUEST, NOW, runGog), { note: NOTHING_ON });
  assert.deepEqual(await buildSchedule(config, { start: "2026-10-09", query: "dentist" }, GUEST, NOW, runGog), { note: NO_MATCH });
  assert.deepEqual(read, []);
});

test("a long usual line is cut at an item boundary and ends +N more", async () => {
  const routine = Array.from({ length: 150 }, (_, i) =>
    timed(`r${i}`, `Routine number ${String(i).padStart(3, "0")}`, "2026-10-09", `0${Math.floor(i / 60) + 6}:${String(i % 60).padStart(2, "0")}`.slice(-5), "11:00", {
      recurringEventId: `r${i}`,
    }),
  );
  const { output } = await schedule({ start: "2026-10-09" }, OWNER, { family: routine });
  assert.ok("sections" in output && output.usual !== undefined);
  assert.ok(output.usual.length <= 2000, String(output.usual.length));
  const bits = output.usual.slice("Usual: ".length).split(" · ");
  const more = Number(bits.at(-1)?.match(/^\+(\d+) more$/)?.[1]);
  assert.equal(bits.length - 1 + more, 150);
  assert.ok(output.usual.startsWith("Usual: Routine number 000 6:00 AM · Routine number 001 6:01 AM"));
});

test("member keeps a shared calendar nobody owns, like the page's member chip", async () => {
  const { config, runGog } = household(EVENTS, {
    calendars: [
      { id: "family", label: "Family", kind: "shared", owners: [] },
      { id: "donnie", label: "Donnie", kind: "personal", owners: ["donnie"] },
    ],
  });
  const output = await buildSchedule(config, { start: "2026-10-09", member: "calla" }, OWNER, NOW, runGog);
  assert.deepEqual(titles(output), ["PE uniform", "Café social", "Family dinner"]);
});

test("no family_schedule answer carries a Google calendar id: week, lookup, a kid's view or a member's", async () => {
  const ids = { donnie: "donnie@example.com", calla: "calla.k@example.com", family: "family0123@group.calendar.google.com" };
  const calendars = [
    { id: ids.donnie, label: "Donnie", kind: "personal", owners: ["donnie"] },
    { id: ids.calla, label: "Calla", kind: "personal", owners: ["calla"] },
    { id: ids.family, label: "Family", kind: "shared", owners: ["donnie", "britta", "calla", "penny"] },
  ];
  const events = { [ids.donnie]: EVENTS.donnie!, [ids.calla]: EVENTS.calla!, [ids.family]: EVENTS.family! };
  const { config, runGog } = household(events, { calendars });
  const outputs = [
    await buildSchedule(config, {}, OWNER, NOW, runGog),
    await buildSchedule(config, { days: 7 }, OWNER, NOW, runGog),
    await buildSchedule(config, { query: "dentist" }, OWNER, NOW, runGog),
    await buildSchedule(config, {}, CALLA, NOW, runGog),
    await buildSchedule(config, { member: "calla" }, OWNER, NOW, runGog),
  ];
  const wire = JSON.stringify(outputs);
  assert.ok(wire.includes('"id":"c0/dentist"'), wire);
  for (const id of Object.values(ids)) assert.equal(wire.includes(id), false, id);
  assert.equal(wire.includes("@"), false);
});
