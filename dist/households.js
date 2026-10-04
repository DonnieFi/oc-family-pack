import { alertDeliveryFailure } from "./briefs.js";
import { longDay } from "./brief.js";
import { DEMO_CALENDARS, DEMO_MEMBERS } from "./demo.js";
import { afterSchoolLines, dayIsClosed, dueHousehold, householdMessage, inclusiveDays, morningLines, sundayOnOrAfter, weekendLines, } from "./household.js";
import { buildSchedule, readEvents } from "./schedule.js";
import { addDays, localDate } from "./week.js";
const TICK_MS = 60_000;
const TITLE = { morning: "Morning", "after-school": "After school", weekend: "Weekend" };
function minutesOf(instant, timezone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]));
    const hour = Number(parts.hour);
    return (hour === 24 ? 0 : hour) * 60 + Number(parts.minute);
}
export function toDetail(event, timezone) {
    if (event.allDay) {
        return { id: event.id, title: event.title, date: event.start, allDay: true, ...(event.location === undefined ? {} : { location: event.location }) };
    }
    const start = Date.parse(event.start);
    const date = localDate(start, timezone);
    const minutes = minutesOf(start, timezone);
    let endMinutes;
    if (event.end !== undefined) {
        const end = Date.parse(event.end);
        endMinutes = localDate(end, timezone) === date ? minutesOf(end, timezone) : 24 * 60;
    }
    return {
        id: event.id,
        title: event.title,
        date,
        allDay: false,
        minutes,
        ...(endMinutes === undefined ? {} : { endMinutes }),
        ...(event.location === undefined ? {} : { location: event.location }),
    };
}
function itemsOf(output, details) {
    if (!("sections" in output))
        return [];
    const byId = new Map(details.map((detail) => [detail.id, detail]));
    const items = [];
    for (const section of output.sections) {
        if (section.name === "matches")
            continue;
        for (const item of section.items) {
            const detail = byId.get(item.id);
            if (detail === undefined)
                continue;
            const named = section.name;
            items.push({
                id: item.id,
                title: item.title,
                date: detail.date,
                allDay: item.allDay === true || detail.allDay,
                owners: item.owners,
                section: named,
                ...(detail.minutes === undefined ? {} : { minutes: detail.minutes }),
                ...(detail.endMinutes === undefined ? {} : { endMinutes: detail.endMinutes }),
                ...(detail.location === undefined ? {} : { location: detail.location }),
            });
        }
    }
    return items;
}
function rowOf(key, target, outcome) {
    const kind = "household";
    switch (outcome.status) {
        case "sent":
            return { deliveryKey: key, kind, target, status: "sent", receiptJson: JSON.stringify(outcome.receipt) };
        case "partial":
            return { deliveryKey: key, kind, target, status: "partial", errorKind: outcome.errorKind, errorDetail: outcome.detail, receiptJson: JSON.stringify(outcome.receipt) };
        case "claimed":
            return { deliveryKey: key, kind, target, status: "unknown", errorKind: "other", errorDetail: "host already holds this delivery key (claimed)" };
        default:
            return { deliveryKey: key, kind, target, status: outcome.status, errorKind: outcome.errorKind, errorDetail: outcome.detail };
    }
}
function alertLine(kind, date, status) {
    const name = kind === "morning" ? "morning brief" : kind === "after-school" ? "after-school brief" : "weekend preview";
    const what = `The ${name} for ${longDay(date)}`;
    switch (status) {
        case "failed":
            return `${what} was not posted: Family has no Discord id for it in config.`;
        case "held":
            return `${what} has not gone out yet: Discord could not be reached. It may still go out later.`;
        case "partial":
            return `${what} was only partly posted.`;
        case "unknown":
            return `${what} may not have been posted. Check Discord.`;
    }
}
function rangeFor(job) {
    if (job.kind === "morning")
        return { start: job.date, end: addDays(job.date, 1), days: 2 };
    if (job.kind === "after-school")
        return { start: job.date, end: job.date, days: 1 };
    const end = sundayOnOrAfter(job.date);
    return { start: job.date, end, days: inclusiveDays(job.date, end) };
}
async function defaultSchedule(deps, input, now) {
    return buildSchedule(deps.config, input, { viewer: { kind: "owner" } }, now, deps.runGog);
}
async function defaultDetails(deps, start, end) {
    const calendars = deps.config.demo ? DEMO_CALENDARS : deps.config.calendars;
    try {
        const read = await readEvents(deps.config, calendars, { range: { start, end, timezone: deps.config.timezone } }, deps.runGog);
        if (read.status !== "ok")
            return undefined;
        return read.data.map((event) => toDetail(event, deps.config.timezone));
    }
    catch {
        return undefined;
    }
}
async function sendOne(deps, store, job, target, targetId, message, outcome) {
    const key = job.kind === "morning" ? `${job.key}:${targetId}` : job.key;
    if (await store.deliveryDone(key))
        return;
    const result = outcome ?? (await deps.deliver(target, [message], key));
    const row = rowOf(key, targetId, result);
    await store.appendDeliveryLog(row);
    if (row.status !== "sent") {
        deps.log(`oc-family-pack: household brief ${key} logged ${row.status} (${row.errorKind})`);
        await alertDeliveryFailure(deps, store, "household", targetId, (status) => alertLine(job.kind, job.date, status));
    }
}
async function runJob(deps, store, job, now) {
    const { start, end, days } = rangeFor(job);
    const schedule = deps.schedule ?? ((input, at) => defaultSchedule(deps, input, at));
    const detailsOf = deps.details ?? ((from, to) => defaultDetails(deps, from, to));
    let output;
    try {
        output = await schedule({ start, days }, now);
    }
    catch {
        deps.log(`oc-family-pack: household brief ${job.key} waits: the calendar read failed`);
        return;
    }
    if ("error" in output) {
        deps.log(`oc-family-pack: household brief ${job.key} waits: the calendar read failed`);
        return;
    }
    const details = await detailsOf(start, end);
    if (details === undefined) {
        deps.log(`oc-family-pack: household brief ${job.key} waits: the calendar read failed`);
        return;
    }
    const items = itemsOf(output, details);
    const usual = "usual" in output ? output.usual : undefined;
    const hints = deps.config.schoolHints ?? [];
    const lines = job.kind === "morning"
        ? morningLines(items, job.date, hints)
        : job.kind === "after-school"
            ? afterSchoolLines(items, job.date, dayIsClosed(details.map((detail) => detail.title), deps.config.closedDayPhrases ?? []), usual)
            : weekendLines(items, job.date, end);
    if (lines === undefined || lines.length === 0)
        return;
    const message = householdMessage(TITLE[job.kind], lines);
    if (job.kind === "morning") {
        const members = deps.config.demo ? DEMO_MEMBERS : deps.config.members;
        for (const parent of members.filter((member) => member.role === "parent")) {
            await sendOne(deps, store, job, { member: parent.profileId }, parent.profileId, message, undefined);
        }
        return;
    }
    const channel = deps.config.summaryChannel;
    if (channel === undefined) {
        await sendOne(deps, store, job, { channel: "summary" }, "summary", message, {
            status: "failed",
            errorKind: "no-channel",
            detail: "summary channel is not configured",
        });
        return;
    }
    await sendOne(deps, store, job, { channel }, channel, message, undefined);
}
/** One poll: each due household job is read through family_schedule and sent once. */
export async function householdTick(deps, now) {
    const store = deps.store();
    if (!store)
        return;
    for (const job of dueHousehold(now, deps.config)) {
        await runJob(deps, store, job, now);
    }
}
/** Polls every minute from now; ticks never overlap. Returns the stop function. */
export function startHouseholds(deps, now = Date.now) {
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            await householdTick(deps, now());
        }
        catch (error) {
            deps.log(`oc-family-pack: household tick failed: ${error instanceof Error ? error.name : "error"}`);
        }
        finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}
