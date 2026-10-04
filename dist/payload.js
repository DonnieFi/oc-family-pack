import { readGogCalendars } from "./calendar-gog.js";
import { ConfigError } from "./config.js";
import { MAX_WEEK_EVENTS } from "./contract.js";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.js";
import { mergeCopies } from "./merge.js";
import { visibleCalendarIds } from "./visibility.js";
import { groupByDay, resolveMembers, resolveWeek } from "./week.js";
/** The host's bounded-JSON limits for feature results (openclaw `host-hook-json`). Depth, key count, and string length are fixed by the schema. */
const HOST_MAX_NODES = 4096;
const HOST_MAX_BYTES = 262_144;
/** Counts nodes the way the host does: every JSON value, including each array entry and object property value. */
export function jsonNodeCount(value) {
    if (Array.isArray(value)) {
        return value.reduce((sum, entry) => sum + jsonNodeCount(entry), 1);
    }
    if (typeof value === "object" && value !== null) {
        return Object.values(value).reduce((sum, entry) => sum + jsonNodeCount(entry), 1);
    }
    return 1;
}
export function fitsHostLimits(value) {
    return jsonNodeCount(value) <= HOST_MAX_NODES && Buffer.byteLength(JSON.stringify(value), "utf8") <= HOST_MAX_BYTES;
}
function oversizeMessage(eventCount, bytes) {
    const detail = eventCount > MAX_WEEK_EVENTS ? `has ${eventCount} events` : `is ${bytes} bytes`;
    return `This week ${detail}, more than Family can show at once. Remove a busy calendar from the plugin config.`;
}
/** A week too large for the host becomes a calendar error, so the roster and weather still load. */
export function fitWeek(payload) {
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
/** The week payload boundary: Google fields stay on the Gateway. */
function toWire({ google: _google, ...event }) {
    return event;
}
function readCalendar(config, shown, week) {
    if (config.demo) {
        const keys = new Set(shown.map((calendar) => calendar.key));
        return Promise.resolve({ status: "ok", data: demoEvents(week).filter((event) => keys.has(event.calendarKey)), warnings: [] });
    }
    // A household with calendars, none of them this viewer's, is neither empty nor a setup step.
    if (shown.length === 0 && config.calendars.length > 0)
        return Promise.resolve({ status: "hidden" });
    return readGogCalendars({ ...config, calendars: shown }, week);
}
function calendarRef({ key, label, kind, owners }) {
    return { key, label, kind, ownerIds: owners };
}
export async function buildWeekPayload(config, requestedStart, now, readWeather, viewer, access = { canEdit: false, grantReadOnly: false }) {
    let week;
    try {
        // A start in the last week of year 9999 makes addDays throw: the range end is not a four-digit date.
        week = resolveWeek(requestedStart, now, config.timezone);
    }
    catch (error) {
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
    const calendar = read.status === "ok" ? { ...read, data: mergeCopies(read.data).map(toWire) } : read;
    return fitWeek({
        mode: config.demo ? "demo" : "live",
        range: week.range,
        today: week.today,
        days: groupByDay(week.dates, week.today, calendar.status === "ok" ? calendar.data : [], config.timezone),
        members: resolveMembers(members),
        calendars: shown.map(calendarRef),
        calendar,
        weather,
        // The demo has no Google calendar to write to.
        canEdit: access.canEdit && !config.demo,
        calendarsReadOnly: access.canEdit && !config.demo && access.grantReadOnly,
    });
}
