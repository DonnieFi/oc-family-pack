import { addDays, localDate, localTime } from "./week.js";
/**
 * Household brief copy, ported from household_briefs.py without Gmail, a fixed
 * school name, or title-casing. School logistics and closed days match phrases
 * the household configures; both lists ship empty. Times are config, not the
 * donor's fixed hours.
 */
export const HOUSEHOLD_COLOR = 0xb45309;
/** Same length as the 07:00–12:00 morning brief window: a restart still sends, a late one does not. */
export const HOUSEHOLD_WINDOW_MS = 5 * 60 * 60 * 1000;
/** Bernie's after-school and Friday-evening cutoff (household_briefs.py). */
export const AFTERNOON_MINUTES = 14 * 60;
export const LEAVE_BY_MINUTES = 30;
export const MORNING_LIMIT = 5;
export const CONFLICT_LIMIT = 4;
/** Friday when weekendPreviewWeekday is omitted. */
export const DEFAULT_PREVIEW_WEEKDAY = 5;
const DESCRIPTION_MAX = 4000;
const WORK = /\b(standup|stand-up|sync|1:1|1-1|sprint|all-hands)\b/i;
const ACTION = /\b(appointment|dentist|doctor|bill|renew|tax|insurance)\b|meeting with/i;
const CLASS_NOISE = /\b(period|homeroom|class of|block [a-z0-9]|advisory)\b/i;
const FORM = /\b(form|permission|slip|waiver|sign)\b/i;
const GEAR = /\b(gear|cleats|shin|skates|helmet|instrument|bag|kit|glove|bat)\b/i;
const SNACK = /\b(snack|lunch|food)\b/i;
const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
function weekdayOf(date) {
    return new Date(`${date}T12:00:00Z`).getUTCDay();
}
function weekdayShort(date) {
    return shortDay.format(Date.parse(`${date}T12:00:00Z`));
}
/** 12-hour clock with no leading zero on the hour. Negative minutes wrap to the previous evening. */
export function clockFromMinutes(minutes) {
    const day = 24 * 60;
    const wrapped = ((minutes % day) + day) % day;
    const hour24 = Math.floor(wrapped / 60);
    const minute = wrapped % 60;
    const hour = hour24 % 12 || 12;
    return `${hour}:${String(minute).padStart(2, "0")} ${hour24 >= 12 ? "PM" : "AM"}`;
}
function hinted(title, phrases) {
    const low = title.toLowerCase();
    return phrases.some((phrase) => phrase.length > 0 && low.includes(phrase));
}
/** A configured phrase on any title marks the day closed. An empty list never does. */
export function dayIsClosed(titles, phrases) {
    return phrases.length > 0 && titles.some((title) => hinted(title, phrases));
}
function byTime(a, b) {
    if (a.date !== b.date)
        return a.date < b.date ? -1 : 1;
    if (a.allDay !== b.allDay)
        return a.allDay ? -1 : 1;
    return (a.minutes ?? 0) - (b.minutes ?? 0);
}
function who(item) {
    return item.owners.length > 0 ? ` (${item.owners.join(", ")})` : "";
}
function timed(item) {
    return !item.allDay && item.minutes !== undefined;
}
/** The Sunday on or after `date`, so a preview covers that day through Sunday. */
export function sundayOnOrAfter(date) {
    let cursor = date;
    while (weekdayOf(cursor) !== 0)
        cursor = addDays(cursor, 1);
    return cursor;
}
export function inclusiveDays(start, end) {
    let days = 1;
    let cursor = start;
    while (cursor !== end && days < 7) {
        cursor = addDays(cursor, 1);
        days += 1;
    }
    return days;
}
/**
 * Jobs whose send window holds `now`. Morning and after-school are weekdays only.
 * A job with no configured time never comes due. The key has no retry suffix.
 */
export function dueHousehold(now, config) {
    const today = localDate(now, config.timezone);
    const due = [];
    const weekday = weekdayOf(today);
    const holds = (clock) => clock !== undefined && windowHolds(now, today, clock, config.timezone);
    if (weekday >= 1 && weekday <= 5 && holds(config.morningTime)) {
        due.push({ kind: "morning", date: today, key: `household:morning:${today}` });
    }
    if (weekday >= 1 && weekday <= 5 && holds(config.afterSchoolTime)) {
        due.push({ kind: "after-school", date: today, key: `household:after-school:${today}` });
    }
    if (weekday === (config.weekendPreviewWeekday ?? DEFAULT_PREVIEW_WEEKDAY) && holds(config.weekendPreviewTime)) {
        due.push({ kind: "weekend", date: today, key: `household:weekend:${today}` });
    }
    return due;
}
function windowHolds(now, date, clock, timezone) {
    const [hour, minute] = clock.split(":").map(Number);
    const start = localTime(date, hour ?? 0, timezone) + (minute ?? 0) * 60_000;
    const end = Math.min(start + HOUSEHOLD_WINDOW_MS, localTime(addDays(date, 1), 0, timezone));
    return start <= now && now < end;
}
/**
 * Today, plus tomorrow's actionable items. Generic work meetings and configured
 * school phrases stay off this list. Empty means the morning stays quiet.
 */
export function morningLines(items, today, hints) {
    const tomorrow = addDays(today, 1);
    const lines = [];
    for (const item of [...items].sort(byTime)) {
        if (item.section === "uniforms")
            continue;
        if (item.date !== today && item.date !== tomorrow)
            continue;
        if (!item.allDay && item.minutes === undefined)
            continue;
        if (WORK.test(item.title) || hinted(item.title, hints))
            continue;
        const actionable = ACTION.test(item.title);
        if (item.date === tomorrow && !actionable)
            continue;
        if (item.allDay && !actionable)
            continue;
        const when = item.allDay ? "all day" : clockFromMinutes(item.minutes ?? 0);
        const label = item.date === today ? "Today" : "Tomorrow";
        lines.push(`${label} ${when}: ${item.title}${who(item)}`);
        if (lines.length >= MORNING_LIMIT)
            break;
    }
    return lines;
}
function packLine(items) {
    const bits = new Set();
    if (items.some((item) => item.section === "uniforms"))
        bits.add("uniforms");
    for (const item of items) {
        if (FORM.test(item.title))
            bits.add("forms");
        if (GEAR.test(item.title))
            bits.add("gear");
        if (SNACK.test(item.title))
            bits.add("snacks");
    }
    return bits.size > 0 ? `Pack: ${[...bits].sort().join(", ")}` : undefined;
}
/**
 * Afternoon exceptions and a pack list. A usual-day line on its own does not
 * post, and a closed day posts nothing. `usual` is appended only when the post
 * already has something to say.
 */
export function afterSchoolLines(items, today, closed, usual) {
    if (closed)
        return undefined;
    const todayItems = items.filter((item) => item.date === today);
    const events = todayItems.filter((item) => {
        if (item.section === "uniforms")
            return false;
        if (item.allDay)
            return !CLASS_NOISE.test(item.title);
        return timed(item) && item.minutes >= AFTERNOON_MINUTES;
    });
    const pack = packLine(todayItems);
    if (events.length === 0 && pack === undefined)
        return undefined;
    const lines = [...events].sort(byTime).map((item) => {
        const when = item.allDay ? "All day" : clockFromMinutes(item.minutes ?? 0);
        return `${when} — ${item.title}${who(item)}`;
    });
    if (pack !== undefined)
        lines.push(pack);
    if (usual !== undefined)
        lines.push(usual);
    return lines;
}
/** Preview day from 14:00 through Sunday. Nothing major still produces the quiet line. */
export function weekendLines(items, preview, sunday) {
    const inSpan = items.filter((item) => item.date >= preview && item.date <= sunday);
    const shown = inSpan.filter((item) => {
        if (item.section === "uniforms")
            return false;
        if (!timed(item) && !item.allDay)
            return false;
        if (item.date === preview)
            return timed(item) && item.minutes >= AFTERNOON_MINUTES;
        return true;
    });
    const conflicts = conflictLines(inSpan.filter((item) => timed(item) && (item.date !== preview || item.minutes >= AFTERNOON_MINUTES)));
    const pack = packLine(inSpan);
    if (shown.length === 0 && conflicts.length === 0 && pack === undefined) {
        return ["Quiet weekend: nothing major on the calendar."];
    }
    const lines = [...shown].sort(byTime).map((item) => {
        const when = item.allDay || item.minutes === undefined ? "all day" : clockFromMinutes(item.minutes);
        let line = `${weekdayShort(item.date)} ${when} — ${item.title}${who(item)}`;
        if (item.location !== undefined && item.location !== "") {
            line += ` @ ${item.location}`;
            if (item.minutes !== undefined)
                line += ` — leave by ~${clockFromMinutes(item.minutes - LEAVE_BY_MINUTES)}`;
        }
        return line;
    });
    lines.push(...conflicts);
    if (pack !== undefined)
        lines.push(pack);
    return lines;
}
function conflictLines(items) {
    const timedItems = items.filter(timed).sort(byTime);
    const lines = [];
    for (let i = 0; i < timedItems.length; i += 1) {
        const first = timedItems[i];
        const firstEnd = first.endMinutes ?? first.minutes + 60;
        for (let j = i + 1; j < timedItems.length; j += 1) {
            const second = timedItems[j];
            if (second.date !== first.date)
                break;
            const secondEnd = second.endMinutes ?? second.minutes + 60;
            if (second.minutes < firstEnd && first.minutes < secondEnd) {
                lines.push(`Conflict ${weekdayShort(first.date)}: ${first.title} vs ${second.title}`);
                if (lines.length >= CONFLICT_LIMIT)
                    return lines;
            }
        }
    }
    return lines;
}
export function householdMessage(title, lines) {
    let description = lines.join("\n");
    if (description.length > DESCRIPTION_MAX)
        description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
    return { embed: { title, description, color: HOUSEHOLD_COLOR } };
}
