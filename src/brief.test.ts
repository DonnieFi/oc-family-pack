import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dailyEmbed, EMBED_MAX, embedLength, fitEmbed, longDay, pyTitle, shorten, weeklyEmbed, type BriefEvent, type DailyInput } from "./brief.ts";
import type { DiscordEmbed } from "./discord-delivery.ts";

// Made by ~/ocfp-share/runs/s5k.8-bernie-golden.py from Bernie's ui/embeds.py and school_calendar.py.
type Case = {
  name: string;
  kind: "daily" | "weekly";
  timezone: string;
  date?: string;
  monday?: string;
  events: BriefEvent[];
  weather?: DailyInput["weather"];
  garbage?: DailyInput["garbage"];
  agentName?: string;
  expected: DiscordEmbed;
};
const golden = JSON.parse(readFileSync(new URL("./fixtures/brief-golden.json", import.meta.url), "utf8")) as {
  cases: Case[];
  shorten: { text: string; expected: string }[];
  title: { text: string; expected: string }[];
};

for (const golden_ of golden.cases) {
  test(`brief matches Bernie: ${golden_.name}`, () => {
    const embed =
      golden_.kind === "daily"
        ? dailyEmbed({
            date: golden_.date!,
            timezone: golden_.timezone,
            events: golden_.events,
            ...(golden_.weather ? { weather: golden_.weather } : {}),
            ...(golden_.garbage ? { garbage: golden_.garbage } : {}),
            agentName: golden_.agentName!,
          })
        : weeklyEmbed(golden_.monday!, golden_.timezone, golden_.events);
    assert.deepEqual(embed, golden_.expected);
  });
}

test("the golden set covers weather down, garbage down and a week within a few characters of 6000", () => {
  const names = golden.cases.map((entry) => entry.name);
  for (const name of ["daily-weather-down", "daily-garbage-down", "weekly-dst", "weekly-near-6000"]) assert.ok(names.includes(name), name);
  const near = golden.cases.find((entry) => entry.name === "weekly-near-6000")!;
  const length = embedLength(near.expected);
  assert.ok(length > EMBED_MAX - 10 && length <= EMBED_MAX, String(length));
  const daily = golden.cases.find((entry) => entry.name === "daily-weather-down")!.expected;
  assert.ok(!daily.description!.includes("🌤") && !daily.description!.includes("⏱"));
  assert.ok(!golden.cases.find((entry) => entry.name === "daily-garbage-down")!.expected.description!.includes("Garbage"));
});

test("shorten and title match Python's textwrap.shorten and str.title", () => {
  for (const { text, expected } of golden.shorten) assert.equal(shorten(text, 90), expected, JSON.stringify(text));
  for (const { text, expected } of golden.title) assert.equal(pyTitle(text), expected, text);
});

test("day names keep strftime's leading zero", () => {
  assert.equal(longDay("2026-10-04"), "Sunday, October 04");
});

const line = (n: number) => `• **9:00 AM** — ${"z".repeat(n)}`;
const field = (name: string, n: number, lines = 1) => ({ name, value: Array.from({ length: lines }, () => line(n)).join("\n"), inline: false });

test("an embed over 6000 is cut in its longest field values only, each ending in an ellipsis", () => {
  const embed: DiscordEmbed = {
    title: "📅 Week Ahead — November 02 to November 08",
    description: "d".repeat(100),
    footer: { text: "Plus 3 routine item(s): classes, lessons, homework, regular uniforms" },
    fields: [field("Monday, November 02", 1000), field("Tuesday, November 03", 300, 3), field("Wednesday, November 04", 1000), field("Thursday, November 05", 1000), field("Friday, November 06", 1000), field("Saturday, November 07", 1000), field("Sunday, November 08", 200)],
  };
  assert.ok(embedLength(embed) > EMBED_MAX);
  const fitted = fitEmbed(embed);
  assert.equal(embedLength(fitted), EMBED_MAX);
  assert.equal(fitted.title, embed.title);
  assert.equal(fitted.description, embed.description);
  assert.deepEqual(fitted.footer, embed.footer);
  assert.deepEqual(fitted.fields!.map((entry) => entry.name), embed.fields!.map((entry) => entry.name));
  const sizes = fitted.fields!.map((entry) => [...entry.value].length);
  const cut = fitted.fields!.filter((entry, index) => entry.value !== embed.fields![index]!.value);
  assert.ok(cut.length > 0 && cut.every((entry) => entry.value.endsWith("…")));
  // The short Sunday field is untouched; the long ones end up level within one character.
  assert.equal(fitted.fields![6]!.value, embed.fields![6]!.value);
  const long = sizes.filter((_, index) => fitted.fields![index]!.value.endsWith("…"));
  assert.ok(Math.max(...long) - Math.min(...long) <= 1, String(sizes));
});

test("an embed at or under 6000 is left alone", () => {
  const embed: DiscordEmbed = { title: "t", fields: [field("Monday", 900)] };
  assert.deepEqual(fitEmbed(embed), embed);
});

test("daily brief with every field capped still fits Discord's 6000", () => {
  const events: BriefEvent[] = Array.from({ length: 60 }, (_, index) => ({
    title: `Thing ${index} ${"q".repeat(80)}`,
    start: "2026-11-01T14:00:00Z",
    end: "2026-11-01T15:00:00Z",
    allDay: false,
    calendarKind: "personal",
    owners: [],
  }));
  const embed = dailyEmbed({ date: "2026-11-01", timezone: "America/Halifax", events, agentName: "Hazel" });
  assert.ok(embedLength(embed) <= EMBED_MAX);
  assert.ok(embed.fields![0]!.value.endsWith("…"));
  assert.equal([...embed.fields![0]!.value].length, 1024);
});

test("the 6000 count includes the author name, as Discord's does", () => {
  assert.equal(embedLength({ title: "ab", footer: { text: "c" }, author: { name: "déf" }, fields: [{ name: "g", value: "🎉" }] }), 8);
});

test("all-day lines come first even where the day starts before UTC midnight (Bernie's (not all_day, start) key)", () => {
  const embed = dailyEmbed({
    date: "2026-11-01",
    timezone: "Australia/Sydney",
    agentName: "Hazel",
    events: [
      { title: "Swim", start: "2026-10-31T21:00:00Z", end: "2026-10-31T22:00:00Z", allDay: false, calendarKind: "personal", owners: [] },
      { title: "Market day", start: "2026-11-01", end: "2026-11-02", allDay: true, calendarKind: "shared", owners: [] },
    ],
  });
  assert.equal(embed.fields![0]!.value, "• **All day** — Market day\n• **8:00 AM** — Swim");
});
