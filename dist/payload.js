import { narrowedAudience } from "./audience.js";
import { readGogCalendars } from "./calendar-gog.js";
import { ConfigError } from "./config.js";
import { MAX_WEEK_EVENTS } from "./contract.js";
import { DEMO_CALENDARS, DEMO_MEMBERS, demoEvents } from "./demo.js";
import { dedupEvents, memoryOf } from "./identity.js";
import { eventParticipants, extraParticipantIds } from "./participants.js";
import { mergeGroup } from "./merge.js";
import { memberForViewer, visibleCalendarIds } from "./visibility.js";
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
/** Display identity for the week page. A named appointment can add one event; it does not add the calendar. */
function pageViewer(members, viewer) {
    const member = memberForViewer({ members }, viewer);
    const role = viewer.kind === "owner" || member?.role === "parent" ? "parent" : member?.role === "kid" ? "kid" : "guest";
    return member ? { role, memberId: member.id } : { role };
}
function calendarRef({ key, label, kind, owners }) {
    return { key, label, kind, ownerIds: owners };
}
export async function buildWeekPayload(config, requestedStart, now, readWeather, viewer, access = { canEdit: false, grantReadOnly: false }, identity) {
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
    const viewerMember = memberForViewer({ members }, viewer);
    const kid = viewer.kind !== "owner" && viewerMember?.role === "kid" ? viewerMember : undefined;
    const hidden = kid ? calendars.filter((entry) => !visible.has(entry.id)) : [];
    const [read, weather] = await Promise.all([readCalendar(config, shown, week), readWeather()]);
    // A failed hidden read stays hidden. Its warning would name a calendar this person cannot see.
    const namedHidden = kid && hidden.length > 0 && (read.status === "ok" || read.status === "hidden")
        ? await readCalendar(config, hidden, week).then((extra) => extra.status === "ok"
            ? extra.data.filter((event) => eventParticipants(event, members, config.participantOverrides).ids.includes(kid.id))
            : [])
        : [];
    const visibleKeys = new Set(shown.map((entry) => entry.key));
    const calendarsByKey = new Map(calendars.map((calendar) => [calendar.key, calendar]));
    const merged = read.status === "ok" || namedHidden.length > 0
        ? await dedupEvents([...(read.status === "ok" ? read.data : []), ...namedHidden], memoryOf(identity?.()))
        : undefined;
    const project = (group) => {
        const publicCopies = group.copies.filter((copy) => visibleKeys.has(copy.calendarKey));
        const copies = publicCopies.length > 0 ? publicCopies : group.copies;
        const event = toWire(mergeGroup(copies));
        const audienceIds = narrowedAudience(event, calendarsByKey, members, config.audienceRules);
        if (publicCopies.length === 0) {
            event.id = group.fpId;
            event.calendarKey = "";
            delete event.calendarKeys;
            delete event.htmlLink;
        }
        const ownerIds = [...new Set(copies.flatMap((copy) => calendars.find((calendar) => calendar.key === copy.calendarKey)?.owners ?? []))];
        const participantIds = extraParticipantIds(group.copies, ownerIds, members, config.participantOverrides);
        return {
            ...event,
            fpId: group.fpId,
            ...(participantIds.length > 0 ? { participantIds } : {}),
            ...(audienceIds !== undefined ? { audienceIds } : {}),
        };
    };
    const keep = (event) => kid === undefined || event.audienceIds === undefined || event.audienceIds.includes(kid.id);
    const calendar = read.status === "ok" && merged
        ? { ...read, data: merged.groups.map(project).filter(keep) }
        : namedHidden.length > 0 && merged
            ? { status: "ok", data: merged.groups.map(project).filter(keep), warnings: [] }
            : read;
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
        viewer: pageViewer(members, viewer),
        canEdit: access.canEdit && !config.demo,
        calendarsReadOnly: access.canEdit && !config.demo && access.grantReadOnly,
        ...(config.agentId !== undefined ? { householdAgentId: config.agentId } : {}),
    });
}
