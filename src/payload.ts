import { readGogCalendars } from "./calendar-gog.ts";
import { ConfigError } from "./config.ts";
import { MAX_WEEK_EVENTS } from "./contract.ts";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.ts";
import { mergeCopies } from "./merge.ts";
import type { CalendarConfig, CalendarRef, CalendarState, Config, SourceState, WeatherCard, WeekPayload } from "./types.ts";
import { visibleCalendarIds, type Viewer } from "./visibility.ts";
import { groupByDay, resolveMembers, resolveWeek, type Week } from "./week.ts";

/** The host's bounded-JSON limits for feature results (openclaw `host-hook-json`). Depth, key count, and string length are fixed by the schema. */
const HOST_MAX_NODES = 4096;
const HOST_MAX_BYTES = 262_144;

/** Counts nodes the way the host does: every JSON value, including each array entry and object property value. */
export function jsonNodeCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum: number, entry) => sum + jsonNodeCount(entry), 1);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((sum: number, entry) => sum + jsonNodeCount(entry), 1);
  }
  return 1;
}

export function fitsHostLimits(value: unknown): boolean {
  return jsonNodeCount(value) <= HOST_MAX_NODES && Buffer.byteLength(JSON.stringify(value), "utf8") <= HOST_MAX_BYTES;
}

function oversizeMessage(eventCount: number, bytes: number): string {
  const detail = eventCount > MAX_WEEK_EVENTS ? `has ${eventCount} events` : `is ${bytes} bytes`;
  return `This week ${detail}, more than Family can show at once. Remove a busy calendar from the plugin config.`;
}

/** A week too large for the host becomes a calendar error, so the roster and weather still load. */
export function fitWeek(payload: WeekPayload): WeekPayload {
  const { calendar } = payload;
  if (calendar.status !== "ok" || (calendar.data.length <= MAX_WEEK_EVENTS && fitsHostLimits(payload))) {
    return payload;
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return {
    ...payload,
    days: payload.days.map((day) => ({ ...day, eventIds: [] })),
    calendar: { status: "error", message: oversizeMessage(calendar.data.length, bytes) },
  };
}

function readCalendar(config: Config, shown: CalendarConfig[], week: Week): Promise<CalendarState> {
  if (config.demo) {
    const keys = new Set(shown.map((calendar) => calendar.key));
    return Promise.resolve({ status: "ok", data: demoEvents(week).filter((event) => keys.has(event.calendarKey)), warnings: [] });
  }
  // A household with calendars, none of them this viewer's, is neither empty nor a setup step.
  if (shown.length === 0 && config.calendars.length > 0) return Promise.resolve({ status: "hidden" });
  return readGogCalendars({ ...config, calendars: shown }, week);
}

function calendarRef({ key, label, kind, owners }: CalendarConfig): CalendarRef {
  return { key, label, kind, ownerIds: owners };
}

export async function buildWeekPayload(
  config: Config,
  requestedStart: string | undefined,
  now: number,
  readWeather: () => Promise<SourceState<WeatherCard>>,
  viewer: Viewer,
): Promise<WeekPayload> {
  let week: Week;
  try {
    // A start in the last week of year 9999 makes addDays throw: the range end is not a four-digit date.
    week = resolveWeek(requestedStart, now, config.timezone);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ConfigError("start", "must be a week Family can show");
    }
    throw error;
  }
  const members = config.demo ? DEMO_MEMBERS : config.members;
  const calendars = config.demo ? DEMO_CALENDARS : config.calendars;
  // Hidden calendars are dropped before anything is read, so no count, warning or list entry reveals them.
  const visible = visibleCalendarIds({ members, calendars }, viewer);
  const shown = calendars.filter((entry) => visible.has(entry.id));
  const [read, weather] = await Promise.all([readCalendar(config, shown, week), readWeather()]);
  // Merging runs on visible calendars only, so a merged event never names a hidden one.
  const calendar = read.status === "ok" ? { ...read, data: mergeCopies(read.data) } : read;
  return fitWeek({
    mode: config.demo ? "demo" : "live",
    range: week.range,
    today: week.today,
    days: groupByDay(week.dates, week.today, calendar.status === "ok" ? calendar.data : [], config.timezone),
    members: resolveMembers(members),
    calendars: shown.map(calendarRef),
    calendar,
    weather,
  });
}
