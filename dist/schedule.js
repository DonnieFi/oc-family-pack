import { readGogCalendars } from "./calendar-gog.js";
import { classifyEvent, clockTime, usualLine } from "./classify.js";
import { CLASSES_LINE_MAX, LOOKUP_DAYS_MAX, SCHEDULE_DAYS_MAX, SCHEDULE_ITEMS_MAX, SCHEDULE_SECTIONS, USUAL_MAX } from "./contract.js";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.js";
import { groupCopies, mergeGroup, normalTitle } from "./merge.js";
import { fitsHostLimits } from "./payload.js";
import { visibleCalendarIds } from "./visibility.js";
import { addDays, localDate } from "./week.js";
export const ME_UNKNOWN = "I can't tell who 'me' is here. Name the person.";
export const NOTHING_ON = "Nothing on the calendar.";
export const NO_MATCH = "No match on the calendars you can see.";
const GUEST = { kind: "person", username: undefined };
/**
 * Who is asking, from the host's tool context only. A Discord sender is the roster
 * person with that exact discordId or a guest; the owner flag counts only off Discord.
 */
export function scheduleCaller(members, context) {
    if (context.source !== "tool")
        return { viewer: GUEST };
    const { messageChannel, requesterSenderId, senderIsOwner } = context.tool;
    if (messageChannel === "discord") {
        const person = requesterSenderId === undefined ? undefined : members.find((member) => member.discordId === requesterSenderId);
        return person ? { viewer: { kind: "person", username: person.profileId }, me: person.profileId } : { viewer: GUEST };
    }
    return { viewer: senderIsOwner === true ? { kind: "owner" } : GUEST };
}
/** When copies of one event classify differently, the earliest section here wins. */
const PRECEDENCE = ["homework", "uniforms", "not the usual", "classes", "usual"];
const words = (text) => normalTitle(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
/** "Fri Oct 9" for a YYYY-MM-DD date. */
function dayLabel(date) {
    const parts = Object.fromEntries(dayFormat.formatToParts(Date.parse(`${date}T12:00:00Z`)).map((part) => [part.type, part.value]));
    return `${parts.weekday} ${parts.month} ${parts.day}`;
}
/** Cuts a " · " list at an item boundary so it fits `max`, ending "+N more". */
function fitLine(prefix, bits, max) {
    const whole = prefix + bits.join(" · ");
    if (whole.length <= max)
        return whole;
    for (let keep = bits.length - 1; keep >= 0; keep -= 1) {
        const line = `${prefix}${[...bits.slice(0, keep), `+${bits.length - keep} more`].join(" · ")}`;
        if (line.length <= max)
            return line;
    }
    return `+${bits.length} more`;
}
function classify(event, kind) {
    const input = {
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendarKind: kind,
        ...(event.google?.recurringEventId === undefined ? {} : { recurringEventId: event.google.recurringEventId }),
        ...(event.google?.originalStart === undefined ? {} : { originalStart: event.google.originalStart }),
    };
    const { routine, homework, uniform } = classifyEvent(input);
    const section = homework ? "homework" : uniform ? "uniforms" : !routine ? "not the usual" : kind === "school" ? "classes" : "usual";
    const due = (homework ?? uniform)?.dueDate;
    return { ...event, section, input, ...(due === undefined ? {} : { due }) };
}
async function readEvents(config, shown, span, runGog) {
    if (config.demo) {
        const keys = new Set(shown.map((calendar) => calendar.key));
        return { status: "ok", data: demoEvents(span).filter((event) => keys.has(event.calendarKey)), warnings: [] };
    }
    return readGogCalendars({ ...config, calendars: shown }, span, runGog);
}
/** The `family_schedule` tool: sections a parent scans, or title matches, from the calendars `viewer` may see. */
export async function buildSchedule(config, input, caller, now, runGog) {
    const timezone = config.timezone;
    const query = input.query === undefined ? [] : words(input.query);
    // A query with no words would match everything, so it reads as no query and keeps the week cap.
    const lookup = query.length > 0;
    // "When's the dentist?" means the coming months, not today, so a lookup defaults to its whole range.
    const days = input.days ?? (lookup ? LOOKUP_DAYS_MAX : 1);
    if (days > (lookup ? LOOKUP_DAYS_MAX : SCHEDULE_DAYS_MAX)) {
        return { error: lookup ? `days must be ${LOOKUP_DAYS_MAX} or fewer.` : `days must be ${SCHEDULE_DAYS_MAX} or fewer without a query.` };
    }
    const members = config.demo ? DEMO_MEMBERS : config.members;
    const calendars = config.demo ? DEMO_CALENDARS : config.calendars;
    let member = input.member;
    if (member === "me") {
        if (caller.me === undefined)
            return { error: ME_UNKNOWN };
        member = caller.me;
    }
    else if (member !== undefined && !members.some((entry) => entry.profileId === member)) {
        return { error: "member must be a profileId from the family roster, or \"me\"." };
    }
    let start;
    let end;
    try {
        start = input.start ?? localDate(now, timezone);
        end = addDays(start, days);
    }
    catch (error) {
        if (error instanceof RangeError)
            return { error: "start must be a date Family can show." };
        throw error;
    }
    const span = { range: { start, end: addDays(end, -1), timezone } };
    // Visibility first, then the member filter, so a member name never reaches a hidden calendar.
    const visible = visibleCalendarIds({ members, calendars }, caller.viewer);
    const shown = calendars.filter((calendar) => visible.has(calendar.id) && (member === undefined || calendar.kind === "shared" || calendar.owners.includes(member)));
    const empty = lookup ? NO_MATCH : NOTHING_ON;
    if (shown.length === 0 && calendars.length > 0)
        return { note: empty };
    const read = await readEvents(config, shown, span, runGog);
    if (read.status === "hidden")
        return { note: empty };
    if (read.status === "unconfigured")
        return { error: read.hint };
    if (read.status === "error")
        return { error: read.message };
    const warnings = read.warnings.length > 0 ? { warnings: read.warnings } : {};
    const byKey = new Map(shown.map((calendar) => [calendar.key, calendar]));
    const dayOf = (event) => (event.allDay ? event.start : localDate(Date.parse(event.start), timezone));
    const inRange = (event) => event.allDay ? event.start < end && event.end > start : dayOf(event) < end && localDate(Math.max(Date.parse(event.end) - 1, Date.parse(event.start)), timezone) >= start;
    const copies = read.data.flatMap((event) => {
        const calendar = byKey.get(event.calendarKey);
        if (!calendar || !inRange(event))
            return [];
        if (lookup) {
            const title = new Set(words(event.title));
            if (!query.every((word) => title.has(word)))
                return [];
        }
        return [classify(event, calendar.kind)];
    });
    const order = new Map(members.map((entry, index) => [entry.profileId, index]));
    const names = new Map(members.map((entry) => [entry.profileId, entry.displayName]));
    const ownersOf = (group) => [...new Set(group.flatMap((copy) => byKey.get(copy.calendarKey)?.owners ?? []))]
        .filter((id) => names.has(id))
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
        .map((id) => names.get(id) ?? id);
    const sortKey = (event) => (event.allDay ? `${event.start}T00` : new Date(Date.parse(event.start)).toISOString());
    const merged = groupCopies(copies)
        .map((group) => {
        const best = group.reduce((a, b) => (PRECEDENCE.indexOf(b.section) < PRECEDENCE.indexOf(a.section) ? b : a));
        const event = mergeGroup(group);
        return { event, section: best.section, due: best.due, input: best.input, owners: ownersOf(group) };
    })
        .sort((a, b) => (sortKey(a.event) < sortKey(b.event) ? -1 : sortKey(a.event) > sortKey(b.event) ? 1 : a.event.title.localeCompare(b.event.title)));
    const item = ({ event, due, owners }) => ({
        title: event.title,
        ...(event.allDay ? { allDay: true } : { time: clockTime(event.start, timezone) }),
        ...(days > 1 ? { date: dayLabel(dayOf(event)) } : {}),
        ...(due === undefined ? {} : { due: dayLabel(due) }),
        owners,
    });
    const lists = lookup
        ? [["matches", merged.map(item)]]
        : SCHEDULE_SECTIONS.map((name) => [name, merged.filter((entry) => entry.section === name).map(item)]);
    const extras = {};
    if (!lookup) {
        const classes = new Map();
        for (const entry of merged.filter((candidate) => candidate.section === "classes")) {
            const date = dayOf(entry.event);
            const prefix = member === undefined && entry.owners.length > 0 ? `${entry.owners.join(", ")}: ` : "";
            const key = `${date}\u0000${prefix}`;
            const line = classes.get(key) ?? { date, prefix, bits: [] };
            line.bits.push(`${entry.event.title} ${clockTime(entry.event.start, timezone)}`);
            classes.set(key, line);
        }
        if (classes.size > 0) {
            extras.classes = [...classes.values()]
                .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
                .map(({ date, prefix, bits }) => ({ ...(days > 1 ? { date: dayLabel(date) } : {}), line: fitLine(prefix, bits, CLASSES_LINE_MAX) }));
        }
        // "Usual" already means it repeats, so one title at one clock time is listed once.
        const seen = new Set();
        const usual = merged.flatMap((entry) => {
            if (entry.section !== "usual")
                return [];
            const key = `${normalTitle(entry.event.title)}\u0000${clockTime(entry.event.start, timezone)}`;
            if (seen.has(key))
                return [];
            seen.add(key);
            return [entry.input];
        });
        const line = usualLine(usual, timezone);
        if (line !== undefined)
            extras.usual = line.length <= USUAL_MAX ? line : fitLine("Usual: ", line.slice("Usual: ".length).split(" · "), USUAL_MAX);
    }
    const total = lists.reduce((sum, [, items]) => sum + items.length, 0);
    if (total === 0 && extras.classes === undefined && extras.usual === undefined)
        return { note: empty, ...warnings };
    // Fill the cap in section order; long titles and owner names can still pass the host's byte limit, so shrink until it fits.
    const render = (limit) => {
        let left = limit;
        const sections = lists.flatMap(([name, items]) => {
            const kept = items.slice(0, Math.max(left, 0));
            left -= kept.length;
            return kept.length > 0 ? [{ name, items: kept }] : [];
        });
        const shownCount = Math.min(limit, total);
        return { sections, ...extras, ...(total > shownCount ? { more: `+${total - shownCount} more` } : {}), ...warnings };
    };
    let limit = Math.min(total, SCHEDULE_ITEMS_MAX);
    let output = render(limit);
    while (limit > 0 && !fitsHostLimits(output)) {
        limit -= 1;
        output = render(limit);
    }
    return output;
}
