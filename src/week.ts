import type { FamilyEvent, Member, MemberConfig, WeekDay, WeekRange } from "./types.ts";

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MEMBER_PALETTE = [
  "oklch(0.72 0.14 245)",
  "oklch(0.72 0.16 55)",
  "oklch(0.72 0.18 310)",
  "oklch(0.75 0.15 150)",
] as const;

export function parseDate(value: string): number | undefined {
  const match = DATE.exec(value);
  if (!match) {
    return undefined;
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}

export function addDays(date: string, days: number): string {
  const time = parseDate(date);
  if (time === undefined) {
    throw new RangeError(`Invalid date ${date}`);
  }
  return new Date(time + days * DAY_MS).toISOString().slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(instant: number, timezone: string): Record<string, number> {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  return parts;
}

export function localDate(instant: number, timezone: string): string {
  const { year = 0, month = 1, day = 1 } = zoneParts(instant, timezone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function offsetMs(instant: number, timezone: string): number {
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = zoneParts(instant, timezone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(instant / 1000) * 1000;
}

/** The instant showing wall-clock `wall` (a UTC-based ms value) in `timezone`, correcting once for a DST shift between guess and answer. */
function zonedInstant(wall: number, timezone: string): number {
  return wall - offsetMs(wall - offsetMs(wall, timezone), timezone);
}

function wallClock(date: string, hours = 0): number {
  const wall = parseDate(date);
  if (wall === undefined) {
    throw new RangeError(`Invalid date ${date}`);
  }
  return wall + hours * 3_600_000;
}

/** The instant a local wall-clock time occurs: `hours` after the local midnight of `date`, read off the clock, not elapsed. */
export function localTime(date: string, hours: number, timezone: string): number {
  return zonedInstant(wallClock(date, hours), timezone);
}

/** The first instant of a local date in `timezone`. */
export function startOfLocalDay(date: string, timezone: string): number {
  const midnight = zonedInstant(wallClock(date), timezone);
  if (localDate(midnight, timezone) === date) {
    return midnight;
  }
  // A forward DST shift skipped midnight, so the guess landed on the previous evening. The day
  // begins at the shift, which lies before the instant the old offset gives for midnight.
  let before = midnight;
  let after = wallClock(date) - offsetMs(midnight, timezone);
  while (after - before > 1000) {
    const middle = before + Math.floor((after - before) / 2000) * 1000;
    if (localDate(middle, timezone) === date) {
      after = middle;
    } else {
      before = middle;
    }
  }
  return after;
}

function mondayOf(date: string): string {
  const weekday = new Date(parseDate(date) ?? 0).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export type Week = { range: WeekRange; today: string; dates: string[] };

export function resolveWeek(requestedStart: string | undefined, now: number, timezone: string): Week {
  const today = localDate(now, timezone);
  const start = mondayOf(requestedStart && parseDate(requestedStart) !== undefined ? requestedStart : today);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return { range: { start, end: dates[6] ?? start, timezone }, today, dates };
}

function eventSpan(event: FamilyEvent, timezone: string): [string, string] {
  if (event.allDay) {
    const last = addDays(event.end, -1);
    return [event.start, last < event.start ? event.start : last];
  }
  const start = Date.parse(event.start);
  const end = Math.max(start, Date.parse(event.end) - 1);
  return [localDate(start, timezone), localDate(end, timezone)];
}

function eventOrder(a: FamilyEvent, b: FamilyEvent): number {
  if (a.allDay !== b.allDay) {
    return a.allDay ? -1 : 1;
  }
  const byStart = a.allDay ? a.start.localeCompare(b.start) : Date.parse(a.start) - Date.parse(b.start);
  return byStart || a.title.localeCompare(b.title);
}

/** Places each event on every local day it overlaps, so overnight and multi-day events show on each day. */
export function groupByDay(dates: string[], today: string, events: FamilyEvent[], timezone: string): WeekDay[] {
  const spans = events.toSorted(eventOrder).map((event) => ({ event, span: eventSpan(event, timezone) }));
  return dates.map((date) => ({
    date,
    isToday: date === today,
    eventIds: spans.filter(({ span }) => span[0] <= date && date <= span[1]).map(({ event }) => event.id),
  }));
}

/** Page roster only. discordId and devices stay in config and are not copied here. */
export function resolveMembers(members: MemberConfig[]): Member[] {
  return members.map((member, index) => ({
    profileId: member.profileId,
    displayName: member.displayName,
    role: member.role,
    color: member.color ?? MEMBER_PALETTE[index % MEMBER_PALETTE.length] ?? MEMBER_PALETTE[0],
  }));
}
