import { classifyEvent } from "./classify.js";
import { MAX_WEEK_EVENTS } from "./contract.js";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.js";
import { buildHighlightLines } from "./highlights.js";
import { readEvents } from "./schedule.js";
import { visibleCalendarIds } from "./visibility.js";
import { localDate, resolveWeek } from "./week.js";
const HOUR_MS = 3_600_000;
const LOOKAHEAD_MS = 4 * HOUR_MS;
/** Local today, and far enough either side for a class that just ended or an event inside four hours. */
function span(now, timezone) {
    const today = localDate(now, timezone);
    const early = localDate(now - HOUR_MS, timezone);
    const late = localDate(now + LOOKAHEAD_MS, timezone);
    return { start: early < today ? early : today, end: late > today ? late : today, timezone };
}
function overlapsToday(event, today, timezone) {
    if (event.allDay)
        return event.start <= today && today < event.end;
    const startMs = Date.parse(event.start);
    if (!Number.isFinite(startMs))
        return false;
    const endMs = Date.parse(event.end);
    const start = localDate(startMs, timezone);
    const end = localDate(Math.max((Number.isFinite(endMs) ? endMs : startMs) - 1, startMs), timezone);
    return start <= today && today <= end;
}
function ownerIds(calendar, members) {
    const order = new Map(members.map((member, index) => [member.profileId, index]));
    return calendar.owners.filter((id) => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
function classifyInput(event, kind) {
    return {
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendarKind: kind,
        ...(event.google?.recurringEventId === undefined ? {} : { recurringEventId: event.google.recurringEventId }),
        ...(event.google?.originalStart === undefined ? {} : { originalStart: event.google.originalStart }),
    };
}
/**
 * Today's urgent lines and noteworthy events, from the calendars `caller` may see.
 * Demo mode uses the demo week, not a one-day slice. No garbage calendar means no garbage line.
 */
export async function buildToday(config, caller, now, deps = {}) {
    const timezone = config.timezone;
    const today = localDate(now, timezone);
    const members = config.demo ? DEMO_MEMBERS : config.members;
    const calendars = config.demo ? DEMO_CALENDARS : config.calendars;
    const visible = visibleCalendarIds({ members, calendars }, caller.viewer);
    const shown = calendars.filter((calendar) => visible.has(calendar.id));
    const byKey = new Map(shown.map((calendar) => [calendar.key, calendar]));
    let garbageTomorrow = false;
    if (config.garbageIcsUrl !== undefined && deps.garbage) {
        garbageTomorrow = (await deps.garbage.tomorrow(config.garbageIcsUrl, timezone, now)) !== undefined;
    }
    let read = [];
    if (shown.length > 0) {
        if (config.demo) {
            const keys = new Set(shown.map((calendar) => calendar.key));
            read = demoEvents(resolveWeek(undefined, now, timezone)).filter((event) => keys.has(event.calendarKey));
        }
        else {
            const loaded = await readEvents(config, shown, { range: span(now, timezone) }, deps.runGog);
            if (loaded.status === "error")
                throw new Error(loaded.message);
            if (loaded.status === "unconfigured")
                throw new Error(loaded.hint);
            if (loaded.status === "ok")
                read = loaded.data;
        }
    }
    const scored = [];
    const exceptions = [];
    for (const event of read) {
        const calendar = byKey.get(event.calendarKey);
        if (!calendar)
            continue;
        const startMs = Date.parse(event.start);
        const endMs = Date.parse(event.end);
        scored.push({
            summary: event.title,
            startMs,
            endMs: Number.isFinite(endMs) ? endMs : startMs,
            allDay: event.allDay,
            school: calendar.kind === "school",
        });
        if (!overlapsToday(event, today, timezone) || classifyEvent(classifyInput(event, calendar.kind)).routine)
            continue;
        exceptions.push({
            id: event.id,
            title: event.title,
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            ...(event.location === undefined ? {} : { location: event.location }),
            calendarKey: event.calendarKey,
            ownerIds: ownerIds(calendar, members),
        });
    }
    exceptions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
    return {
        date: today,
        highlights: buildHighlightLines(scored, now, timezone, garbageTomorrow),
        exceptions: exceptions.slice(0, MAX_WEEK_EVENTS),
    };
}
