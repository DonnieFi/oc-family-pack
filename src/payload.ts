import { readGogCalendars } from "./calendar-gog.ts";
import { MAX_WEEK_EVENTS } from "./contract.ts";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.ts";
import type { CalendarConfig, CalendarRef, CalendarState, Config, SourceState, WeatherCard, WeekPayload } from "./types.ts";
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

/** A week too large for the host becomes a calendar error, so the roster and weather still load. */
export function fitWeek(payload: WeekPayload): WeekPayload {
  const { calendar } = payload;
  if (calendar.status !== "ok" || (calendar.data.length <= MAX_WEEK_EVENTS && fitsHostLimits(payload))) {
    return payload;
  }
  return {
    ...payload,
    days: payload.days.map((day) => ({ ...day, eventIds: [] })),
    calendar: {
      status: "error",
      message: `This week has ${calendar.data.length} events, more than Family can show at once. Remove a busy calendar from the plugin config.`,
    },
  };
}

function readCalendar(config: Config, week: Week): Promise<CalendarState> {
  return config.demo ? Promise.resolve({ status: "ok", data: demoEvents(week), warnings: [] }) : readGogCalendars(config, week);
}

function calendarRef({ key, label, kind, owners }: CalendarConfig): CalendarRef {
  return { key, label, kind, ownerIds: owners };
}

export async function buildWeekPayload(
  config: Config,
  requestedStart: string | undefined,
  now: number,
  readWeather: () => Promise<SourceState<WeatherCard>>,
): Promise<WeekPayload> {
  const week = resolveWeek(requestedStart, now, config.timezone);
  const [calendar, weather] = await Promise.all([readCalendar(config, week), readWeather()]);
  return fitWeek({
    mode: config.demo ? "demo" : "live",
    range: week.range,
    today: week.today,
    days: groupByDay(week.dates, week.today, calendar.status === "ok" ? calendar.data : [], config.timezone),
    members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
    calendars: (config.demo ? DEMO_CALENDARS : config.calendars).map(calendarRef),
    calendar,
    weather,
  });
}
