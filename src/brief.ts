import { classifyEvent, clockTime, DEFAULT_VOCABULARY, usualLine, type ClassifyInput } from "./classify.ts";
import type { DiscordEmbed } from "./discord-delivery.ts";
import { roundHalfEven } from "./recommendation.ts";
import type { WeatherCard } from "./types.ts";
import { addDays, localDate } from "./week.ts";

// Ported from Bernie's bot/ui/embeds.py (build_summary_embed :54-116, build_weekly_embed :175-205,
// _field_value and _schedule_line :163-172) and the school_calendar.py rules they call.

/** One calendar event as the briefs read it: the classifier's fields plus what a line shows. */
export type BriefEvent = ClassifyInput & {
  location?: string;
  description?: string;
  /** Owner display names in roster order; Bernie's attendees. */
  owners: string[];
};

/** discord.Color.gold() and discord.Color.blue() (discord.py 2.7.1). */
export const DAILY_COLOR = 0xf1c40f;
export const WEEKLY_COLOR = 0x3498db;
/** Discord's limit on everything an embed shows, counted in characters (code points). */
export const EMBED_MAX = 6000;
const FIELD_MAX = 1024;

const length = (text: string) => [...text].length;

const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "2-digit" });
/** strftime "%A, %B %d": "Monday, November 02". */
export function longDay(date: string): string {
  const parts = Object.fromEntries(dayName.formatToParts(Date.parse(`${date}T12:00:00Z`)).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day}`;
}

/** strftime "%B %d": "November 02". */
function monthDay(date: string): string {
  return longDay(date).split(", ")[1]!;
}

/** Python's str.title(): a cased letter is upper after anything uncased, lower after a cased one, so "it's" is "It'S". */
export function pyTitle(text: string): string {
  let out = "";
  let previousCased = false;
  for (const char of text) {
    const cased = char.toLowerCase() !== char.toUpperCase();
    out += cased ? (previousCased ? char.toLowerCase() : char.toUpperCase()) : char;
    previousCased = cased;
  }
  return out;
}

// textwrap.TextWrapper.wordsep_re (CPython 3.13 Lib/textwrap.py), with Python's Unicode \w and \d.
const W = String.raw`[\p{L}\p{N}_]`;
const WORD_PUNCT = String.raw`[\p{L}\p{N}_!"'&.,?]`;
const LETTER = String.raw`[\p{L}\p{Nl}\p{No}_]`;
const WS = String.raw`[\t\n\v\f\r ]`;
const NWS = String.raw`[^\t\n\v\f\r ]`;
const WORDSEP = new RegExp(
  String.raw`(${WS}+|(?<=${WORD_PUNCT})-{2,}(?=${W})|${NWS}+?(?:-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})|(?=${WS}|$)|(?<=${WORD_PUNCT})(?=-{2,}${W})))`,
  "u",
);

/** textwrap.shorten(text, width, placeholder): whitespace collapsed, then cut at a word boundary with the placeholder after it. */
export function shorten(text: string, width: number, placeholder = "…"): string {
  const joined = text.trim().split(/[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean).join(" ");
  if (joined === "") return "";
  const chunks = joined.split(WORDSEP).filter((chunk) => chunk !== "");
  // _wrap_chunks with max_lines=1 and drop_whitespace, on code-point lengths.
  const line: string[] = [];
  let used = 0;
  while (chunks.length > 0 && used + length(chunks[0]!) <= width) {
    used += length(chunks[0]!);
    line.push(chunks.shift()!);
  }
  if (chunks.length > 0 && length(chunks[0]!) > width) {
    // _handle_long_word: break the word at the space left, or after a hyphen inside it.
    const chunk = [...chunks[0]!];
    const left = Math.max(width - used, 1);
    let end = left;
    const hyphen = chunk.slice(0, left).lastIndexOf("-");
    if (hyphen > 0 && chunk.slice(0, hyphen).some((char) => char !== "-")) end = hyphen + 1;
    line.push(chunk.slice(0, end).join(""));
    chunks[0] = chunk.slice(end).join("");
    used = line.reduce((sum, part) => sum + length(part), 0);
  }
  if (line.length > 0 && line.at(-1)!.trim() === "") used -= length(line.pop()!);
  if (line.length === 0) return "";
  const rest = chunks.filter((chunk) => chunk !== "");
  if ((rest.length === 0 || (rest.length === 1 && rest[0]!.trim() === "")) && used <= width) return line.join("");
  while (line.length > 0) {
    if (line.at(-1)!.trim() !== "" && used + length(placeholder) <= width) return line.join("") + placeholder;
    used -= length(line.pop()!);
  }
  return placeholder.trimStart();
}

/** _field_value: lines joined, cut to 1024 with "…". */
export function fieldValue(lines: readonly string[]): string {
  const value = lines.join("\n");
  const chars = [...value];
  return chars.length <= FIELD_MAX ? value : `${chars.slice(0, FIELD_MAX - 1).join("")}…`;
}

const dayOf = (event: BriefEvent, timezone: string) => (event.allDay ? event.start : localDate(Date.parse(event.start), timezone));

/** occurs_on: family all-day events cover their span; school all-day rows only their start date; timed events their start date. */
export function occursOn(event: BriefEvent, day: string, timezone: string): boolean {
  if (event.allDay && event.calendarKind !== "school") return event.start <= day && day < event.end;
  return dayOf(event, timezone) === day;
}

/** _schedule_line: "• **10:00 AM** — Dentist (Riley) 📍 Main St". */
export function scheduleLine(event: BriefEvent, timezone: string): string {
  const when = event.allDay ? "All day" : clockTime(event.start, timezone);
  const who = event.owners.length > 0 ? ` (${event.owners.join(", ")})` : "";
  const where = event.location ? ` 📍 ${event.location}` : "";
  return `• **${when}** — ${event.title}${who}${where}`;
}

/** Bernie's sort key (not all_day, start): all-day first, then by start. Stable for ties. */
function scheduleOrder(events: readonly BriefEvent[]): BriefEvent[] {
  const at = (event: BriefEvent) => (event.allDay ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start));
  return [...events].sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || at(a) - at(b));
}

/** weather_line (weather_service.py:839-847) for a card with no reading to recommend from. The citypage gives no wind direction. */
export function weatherLine(card: WeatherCard): string {
  const temp = card.tempC === undefined ? "—°C" : `${roundHalfEven(card.tempC)}°C`;
  const highLow = [card.highC === undefined ? "" : `H ${roundHalfEven(card.highC)}°`, card.lowC === undefined ? "" : `L ${roundHalfEven(card.lowC)}°`].filter(Boolean).join(" / ");
  const wind = card.windKmh === undefined ? "" : `  💨 ${card.windKmh} km/h `;
  return `${card.condition ?? "—"} · ${temp}${highLow ? `  (${highLow})` : ""}${wind}`;
}

export type DailyInput = {
  /** The brief's date in the household zone. */
  date: string;
  timezone: string;
  events: readonly BriefEvent[];
  weather?: WeatherCard;
  garbage?: { icon: string; summary: string };
  agentName: string;
};

/** build_summary_embed (ui/embeds.py:54-116). */
export function dailyEmbed(input: DailyInput): DiscordEmbed {
  const { date, timezone, events } = input;
  const embed: DiscordEmbed = { title: `🌅 ${longDay(date)}`, color: DAILY_COLOR };
  const context: string[] = [];
  const rec = input.weather?.recommendation;
  if (rec) {
    context.push(`🌤 ${rec.summary}`);
    if (rec.alerts.length > 0) context.push(`⏱ ${rec.alerts[0]}`);
  } else if (input.weather) {
    context.push(`🌤 ${weatherLine(input.weather)}`);
  }
  if (input.garbage) context.push(`${input.garbage.icon} **Garbage tomorrow:** ${pyTitle(input.garbage.summary)}`);
  if (context.length > 0) embed.description = context.join("\n");

  const classified = events.map((event) => ({ event, ...classifyEvent(event) }));
  const unusual = scheduleOrder(classified.filter((c) => occursOn(c.event, date, timezone) && !c.routine && !c.uniform).map((c) => c.event));
  const today = unusual.length > 0 ? unusual.map((event) => scheduleLine(event, timezone)) : ["_Nothing out of the ordinary._"];
  const usual = usualLine(events, timezone);
  if (usual) today.push(`_${usual}_`);
  const fields: NonNullable<DiscordEmbed["fields"]> = [{ name: "📌 Today", value: fieldValue(today), inline: false }];

  const homework = classified.filter((c) => c.homework?.dueDate === date && c.routine);
  if (homework.length > 0) {
    const lines = homework.map(({ event }) => {
      const value = shorten(event.description ?? "", 90);
      return value ? `• **${event.title}** — ${value}` : `• **${event.title}**`;
    });
    fields.push({ name: "📚 Homework (Due Today)", value: fieldValue(lines), inline: false });
  }
  // todays_uniform_lines (school_calendar.py:112-128): only the routine-uniform pattern hides a note.
  const uniforms = classified.filter((c) => c.uniform?.dueDate === date && !DEFAULT_VOCABULARY.routineUniform.test(c.event.title));
  if (uniforms.length > 0) {
    const lines = uniforms.map(({ event }) => `• **${event.owners[0] ?? "Kid"}** — ${event.title || "uniform"}`);
    fields.push({ name: "👕 Uniforms", value: fieldValue(lines), inline: false });
  }
  embed.fields = fields;
  embed.footer = { text: `Chat with ${input.agentName} anytime to manage events` };
  return fitEmbed(embed);
}

/** build_weekly_embed (ui/embeds.py:175-205): the week from `monday`, exceptions only, routine items counted. */
export function weeklyEmbed(monday: string, timezone: string, events: readonly BriefEvent[]): DiscordEmbed {
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  const byDay = new Map<string, BriefEvent[]>();
  let routine = 0;
  for (const event of events) {
    const day = days.find((candidate) => occursOn(event, candidate, timezone));
    if (day === undefined) continue;
    if (classifyEvent(event).routine) routine += 1;
    else byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  const embed: DiscordEmbed = { title: `📅 Week Ahead — ${monthDay(days[0]!)} to ${monthDay(days[6]!)}`, color: WEEKLY_COLOR };
  if (byDay.size === 0) embed.description = "Nothing out of the ordinary this week.";
  const fields = days
    .filter((day) => byDay.has(day))
    .map((day) => ({ name: longDay(day), value: fieldValue(scheduleOrder(byDay.get(day)!).map((event) => scheduleLine(event, timezone))), inline: false }));
  if (fields.length > 0) embed.fields = fields;
  if (routine > 0) embed.footer = { text: `Plus ${routine} routine item(s): classes, lessons, homework, regular uniforms` };
  return fitEmbed(embed);
}

/** Everything Discord counts toward the 6000: title, description, field names and values, footer, author. */
export function embedLength(embed: DiscordEmbed & { author?: { name: string } }): number {
  return [embed.title, embed.description, embed.footer?.text, embed.author?.name, ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])].reduce(
    (sum, text) => sum + (text ? length(text) : 0),
    0,
  );
}

/**
 * Over 6000, field values are cut, longest first (the earliest on a tie), each no shorter than the
 * next longest, ending in "…". Titles, names, description and footer are never cut.
 */
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
  const fields = embed.fields?.map((field) => ({ ...field }));
  if (!fields) return embed;
  let over = embedLength(embed) - EMBED_MAX;
  while (over > 0) {
    const sizes = fields.map((field) => length(field.value));
    const longest = sizes.indexOf(Math.max(...sizes));
    const next = Math.max(0, ...sizes.filter((_, index) => index !== longest));
    const keep = Math.max(next, sizes[longest]! - over, 1);
    const target = keep === sizes[longest] ? keep - 1 : keep;
    fields[longest]!.value = `${[...fields[longest]!.value].slice(0, target - 1).join("")}…`;
    over -= sizes[longest]! - target;
  }
  return { ...embed, fields };
}
