import { Type } from "typebox";
import { DEMO_CALENDARS, DEMO_MEMBERS } from "./demo.js";
import {} from "./discord-delivery.js";
import { groupCopies, mergeGroup } from "./merge.js";
import { alertDeliveryFailure } from "./briefs.js";
import { dueReminders, reminderAlert, reminderMessage } from "./reminder.js";
import { requesterFromFacts } from "./requester.js";
import { readEvents } from "./schedule.js";
import { addDays, localDate } from "./week.js";
const TICK_MS = 60_000;
export function leadsOf(config) {
    return config.reminderLeadMinutes ?? [15];
}
export function quietOf(config) {
    return config.quietHours ?? { startHour: 22, endHour: 7 };
}
function roster(config) {
    return config.demo ? DEMO_MEMBERS : config.members;
}
function modeOf(member, stored) {
    return stored[member.profileId] ?? member.reminders ?? "dm";
}
/** Timed events in the window, copies merged, owners in roster order. All-day events are not reminders. */
async function reminderEvents(deps, now) {
    const { config } = deps;
    const timezone = config.timezone;
    const members = roster(config);
    const calendars = config.demo ? DEMO_CALENDARS : config.calendars;
    const start = localDate(now - 24 * 60 * 60_000, timezone);
    const end = addDays(localDate(now, timezone), 2);
    const read = await (deps.readCalendars ?? ((cfg, span) => readEvents(cfg, calendars, span)))(config, { range: { start, end, timezone } });
    if (read.status !== "ok")
        return undefined;
    const byKey = new Map(calendars.map((calendar) => [calendar.key, calendar]));
    const order = new Map(members.map((member, index) => [member.profileId, index]));
    const names = new Map(members.map((member) => [member.profileId, member.displayName]));
    return groupCopies(read.data.filter((event) => !event.allDay && byKey.has(event.calendarKey))).map((group) => {
        const event = mergeGroup(group);
        const owners = [...new Set(group.flatMap((copy) => byKey.get(copy.calendarKey).owners))]
            .filter((id) => names.has(id))
            .sort((a, b) => order.get(a) - order.get(b))
            .map((id) => ({ profileId: id, displayName: names.get(id) }));
        const updated = group.map((copy) => copy.google?.updated).filter((value) => value !== undefined).sort().at(-1) ?? "";
        return {
            id: event.id,
            title: event.title,
            start: event.start,
            end: event.end,
            updated,
            owners,
            ...(event.location === undefined ? {} : { location: event.location }),
        };
    });
}
function rowOf(key, target, outcome) {
    switch (outcome.status) {
        case "sent":
            return { deliveryKey: key, kind: "reminder", target, status: "sent", receiptJson: JSON.stringify(outcome.receipt) };
        case "partial":
            return { deliveryKey: key, kind: "reminder", target, status: "partial", errorKind: outcome.errorKind, errorDetail: outcome.detail, receiptJson: JSON.stringify(outcome.receipt) };
        case "claimed":
            return { deliveryKey: key, kind: "reminder", target, status: "unknown", errorKind: "other", errorDetail: "host already holds this delivery key (claimed)" };
        default:
            return { deliveryKey: key, kind: "reminder", target, status: outcome.status, errorKind: outcome.errorKind, errorDetail: outcome.detail };
    }
}
/** One poll: each due reminder is sent once to each owner, by that person's mode. */
export async function reminderTick(deps, now) {
    const store = deps.store();
    if (!store)
        return;
    const leads = leadsOf(deps.config);
    if (leads.length === 0)
        return;
    const events = await reminderEvents(deps, now);
    if (!events) {
        deps.log("oc-family-pack: reminders wait: the calendar read failed");
        return;
    }
    const stored = await store.reminderModes();
    const members = new Map(roster(deps.config).map((member) => [member.profileId, member]));
    const who = (event) => event.owners.map((owner) => owner.displayName);
    for (const due of dueReminders(events, now, deps.config.timezone, leads, quietOf(deps.config))) {
        const member = members.get(due.profileId);
        const mode = member ? modeOf(member, stored) : "off";
        if (mode === "off")
            continue;
        if (await store.deliveryDone(due.key))
            continue;
        const channel = deps.config.summaryChannel;
        let outcome;
        let target;
        if (mode === "channel" && channel === undefined) {
            outcome = { status: "failed", errorKind: "no-channel", detail: "no summary channel in config" };
            target = due.profileId;
        }
        else if (mode === "channel" && channel !== undefined) {
            const discordId = member?.discordId;
            const mention = discordId ? `<@${discordId}>` : due.displayName;
            outcome = await deps.deliver({ channel }, [reminderMessage(due.event, due.minsUntil, deps.config.timezone, who(due.event), mention)], due.key);
            target = channel;
        }
        else {
            outcome = await deps.deliver({ member: due.profileId }, [reminderMessage(due.event, due.minsUntil, deps.config.timezone, who(due.event))], due.key);
            target = due.profileId;
        }
        const row = rowOf(due.key, target, outcome);
        await store.appendDeliveryLog(row);
        if (row.status !== "sent") {
            deps.log(`oc-family-pack: reminder logged ${row.status} (${row.errorKind})`);
            await alertDeliveryFailure({ config: deps.config, deliver: deps.deliver }, store, "reminder", target, (status) => reminderAlert(due.event.title, status));
        }
    }
}
/** Polls every minute from now; ticks never overlap. Returns the stop function. */
export function startReminders(deps, now = Date.now) {
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            await reminderTick(deps, now());
        }
        catch (error) {
            deps.log(`oc-family-pack: reminder tick failed: ${error instanceof Error ? error.name : "error"}`);
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
const MODE_LINE = {
    dm: (name) => `${name} will get reminders in a direct message.`,
    channel: (name) => `${name} will be mentioned in the brief channel.`,
    off: (name) => `${name} will not get event reminders.`,
};
/** A person may change their own mode. A parent, or the operator's owner tool call, may change anyone's. */
export function maySetReminder(requester, target) {
    if (requester.from === "tool" && requester.senderIsOwner)
        return true;
    if (requester.from === "discord" && requester.member) {
        return requester.member.profileId === target.profileId || requester.member.role === "parent";
    }
    return false;
}
/**
 * The chat tool behind "remind me in the channel" / "turn my reminders off".
 * `member` is a roster profileId, or "me" for the person asking on Discord.
 */
export async function setReminderMode(store, members, requester, member, mode) {
    const profileId = member === "me" ? (requester.from === "discord" ? requester.member?.profileId : undefined) : member;
    if (profileId === undefined)
        return { ok: false, text: "I can't tell who is asking. Name the person." };
    const target = members.find((entry) => entry.profileId === profileId);
    if (!target)
        return { ok: false, text: "That person is not in the family." };
    if (!maySetReminder(requester, target))
        return { ok: false, text: "Only a parent, or the person themselves, can change reminder delivery." };
    await store.appendReminderMode(target.profileId, mode);
    return { ok: true, text: MODE_LINE[mode](target.displayName) };
}
/** Facts the tool context carries. A direct-operator HTTP call has no Discord sender. */
export function reminderRequester(members, facts) {
    if (facts.directOperator)
        return { from: "tool", senderIsOwner: facts.senderIsOwner === true };
    return requesterFromFacts(members, facts);
}
export const SET_REMINDER_MODE_TOOL = "set_reminder_mode";
export const SetReminderModeSchema = Type.Object({
    member: Type.String({ minLength: 1, maxLength: 200, description: 'A roster profileId, or "me" for the person asking on Discord.' }),
    mode: Type.Union([Type.Literal("dm"), Type.Literal("channel"), Type.Literal("off")], { description: "A direct message, a mention in the brief channel, or off." }),
}, { additionalProperties: false });
/** The agent's set_reminder_mode tool. The host checks the schema; this checks who is asking. */
export function reminderTool(config, store, facts) {
    const members = roster(config);
    return {
        name: SET_REMINDER_MODE_TOOL,
        label: "Reminder delivery",
        description: "Change how one person gets event reminders: a direct message, a mention in the brief channel, or off. A person can change their own. A parent can change anyone's.",
        parameters: SetReminderModeSchema,
        execute: async (_toolCallId, params) => {
            const input = params;
            const member = typeof input?.member === "string" ? input.member : "";
            const mode = input?.mode === "dm" || input?.mode === "channel" || input?.mode === "off" ? input.mode : undefined;
            const saved = store();
            const result = mode === undefined || member.length === 0
                ? { ok: false, text: "Say who, and whether reminders are a direct message, a channel mention, or off." }
                : saved === undefined
                    ? { ok: false, text: "Family isn't ready to save that yet." }
                    : await setReminderMode(saved, members, reminderRequester(members, facts), member, mode);
            return { content: [{ type: "text", text: result.text }], details: { status: result.ok ? "ok" : "refused" } };
        },
    };
}
