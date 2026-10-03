import { Type } from "typebox";
import { createStamper, STAMP_PARAM } from "./approval-stamp.js";
import { baseKey, checkKey, END_BEFORE_START, loggedFields, normalizeCreate, requesterTag, requestKey, submitCreate, unreachableLine, } from "./calendar-write.js";
import { toolWriteFacts, writeRequesterFromFacts } from "./requester.js";
import { gateWrite, READ_ONLY } from "./write-gate.js";
import { approvers } from "./write-permissions.js";
export const CALENDAR_CREATE_TOOL = "calendar_create";
/** How long a parent has to answer. The host's ceiling is 10 minutes and its default 2, so it is always passed. */
export const APPROVAL_TIMEOUT_MS = 600_000;
/**
 * The host runs before_tool_call hooks highest priority first (openclaw c074824
 * hooks-DMax5We2.mjs getHooksForName). Once this hook asks for approval the host drops every
 * later hook's params, so what the parent approves is what runs. Finite, so it still sorts.
 */
export const CALENDAR_HOOK_PRIORITY = 1_000_000_000;
/** The host's caps on approval text (plugin-approvals TITLE/DESCRIPTION), in code points after its sanitizing. */
export const APPROVAL_TITLE_MAX = 80;
export const APPROVAL_DESCRIPTION_MAX = 512;
/** What the model sees. No series scope, and never the stamp parameter. */
export const CalendarCreateInputSchema = Type.Object({
    calendar: Type.String({ minLength: 1, maxLength: 100, description: "Which calendar, by the name listed in this tool's description." }),
    title: Type.String({ minLength: 1, maxLength: 200, description: "The event's name, such as Sleepover." }),
    start: Type.String({
        minLength: 1,
        maxLength: 40,
        description: "A date and time with its UTC offset, such as 2026-10-09T16:30:00-03:00, or YYYY-MM-DD for an all-day event.",
    }),
    end: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "Same format as start. A timed event needs one; an all-day event defaults to one day." })),
    allDay: Type.Optional(Type.Boolean({ description: "True for an all-day event." })),
    location: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
});
/**
 * Only the requester the host sets on an agent run. On HTTP /tools/invoke and WS tools.invoke
 * the host sets none (openclaw c074824 tools-invoke-shared-BLDZvQjD.mjs:233-249), so both are
 * `tool`; nothing a caller sends (args, session key, headers) is read for the sender.
 */
export function factsFromHook(ctx) {
    return { sessionKey: ctx.sessionKey, channel: ctx.requester?.channel, senderId: ctx.requester?.senderId, senderIsOwner: ctx.requester?.senderIsOwner };
}
/** A direct operator call (HTTP /tools/invoke) is `tool` whatever its headers say: see toolWriteFacts. */
export function factsFromTool(ctx) {
    return { sessionKey: ctx.sessionKey, ...toolWriteFacts(ctx) };
}
/** A problem with what the model asked for. The message is for the person. */
export class CreateInputError extends Error {
}
/** Every parameter but the stamp. The stamp is never hashed, stamped on an event, or logged. */
export function withoutStamp(params) {
    if (typeof params !== "object" || params === null || Array.isArray(params))
        return {};
    const { [STAMP_PARAM]: _stamp, ...rest } = params;
    return rest;
}
function text(params, name) {
    const value = params[name];
    return typeof value === "string" ? value : undefined;
}
function findCalendar(calendars, name) {
    const wanted = name.trim().toLowerCase();
    return calendars.find((calendar) => calendar.key.toLowerCase() === wanted || calendar.label.trim().toLowerCase() === wanted);
}
/**
 * The one way the hook and the tool turn a call into a write: requester, op, calendar,
 * normalized fields and retry scope, hashed by the same `baseKey` the write log uses. The
 * stamp is stripped first. Throws CreateInputError for anything the person has to fix.
 */
export function prepareCreate(setup, facts, params) {
    const input = withoutStamp(params);
    const calendarName = text(input, "calendar");
    const title = text(input, "title")?.trim();
    const start = text(input, "start");
    if (!calendarName || !title || !start)
        throw new CreateInputError("I need the event's name, when it starts, and which calendar to add it to.");
    const calendar = findCalendar(setup.calendars, calendarName);
    if (!calendar)
        throw new CreateInputError(`I couldn't find a calendar called ${calendarName.trim()}, so I didn't add **${title}**.`);
    const fields = { title, start };
    const end = text(input, "end");
    if (end !== undefined)
        fields.end = end;
    if (input.allDay === true)
        fields.allDay = true;
    const location = text(input, "location");
    const description = text(input, "description");
    if (location !== undefined)
        fields.location = location;
    if (description !== undefined)
        fields.description = description;
    let normalized;
    try {
        normalized = normalizeCreate(fields);
    }
    catch (error) {
        if (error instanceof Error && error.message === END_BEFORE_START)
            throw new CreateInputError(END_BEFORE_START);
        throw new CreateInputError(`I couldn't read that date or time, so I didn't add **${title}**.`);
    }
    // writeScope's rule for a tool call: the session key, never the tool call id.
    const scope = facts.sessionKey && facts.sessionKey.trim() ? facts.sessionKey : undefined;
    if (scope === undefined)
        throw new CreateInputError(`Something went wrong checking that, so I didn't add **${title}**.`);
    const requester = writeRequesterFromFacts(setup.members, facts);
    const tag = requesterTag(requester);
    let base;
    try {
        base = baseKey({ requester: tag, op: "create", calendarId: calendar.id, fields: normalized, scope: checkKey(scope) });
    }
    catch {
        throw new CreateInputError(`Something went wrong checking that, so I didn't add **${title}**.`);
    }
    return { base, tag, requester, calendar, fields, normalized };
}
/** The base key alone: the same call gives the same key from the hook's context and the tool's. */
export function deriveBaseKey(setup, facts, params) {
    return prepareCreate(setup, facts, params).base;
}
// ---- What people read ----
/** Control and format characters would be escaped by the host's sanitizer and grow the text. */
function clean(value) {
    return value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
}
function points(value) {
    return [...value].length;
}
/** Cuts to `max` code points, ending with … when anything was cut. */
function fit(value, max) {
    if (points(value) <= max)
        return value;
    if (max <= 0)
        return "";
    return `${[...value].slice(0, max - 1).join("")}…`;
}
function joinWith(names, word) {
    if (names.length <= 1)
        return names[0] ?? "";
    if (names.length === 2)
        return `${names[0]} ${word} ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, ${word} ${names.at(-1)}`;
}
/** "Donnie or Britta", or "the person who set this up" when the roster has no parents. */
export function approverPhrase(members) {
    return joinWith(approvers(members).map(clean), "or");
}
/** "Donnie's calendar" for a personal calendar, "the Family calendar" otherwise. */
export function calendarPlace(members, calendar) {
    if (calendar.kind === "personal") {
        const names = calendar.owners.flatMap((owner) => {
            const member = members.find((entry) => entry.profileId === owner);
            return member ? [clean(member.displayName)] : [];
        });
        if (names.length > 0)
            return `${joinWith(names, "and")}'s calendar`;
    }
    return `the ${clean(calendar.label)} calendar`;
}
/**
 * Bernie's format, /opt/family-bot/bot/tools/calendar.py:168 (family-bot add3fbb) `%A %B %-d at %-I:%M %p`:
 * "Friday October 9 at 4:30 PM" in the family's timezone; an all-day event is "Friday October 9".
 */
export function bernieWhen(fields, timezone) {
    if (fields.allDay) {
        const parts = partsOf(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }), `${fields.start}T12:00:00Z`);
        return `${parts.weekday} ${parts.month} ${parts.day}`;
    }
    const parts = partsOf(new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }), fields.start);
    return `${parts.weekday} ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
function partsOf(format, iso) {
    return Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
}
/** Who asked, by roster name only: never an id, a session key, or a requester tag. */
function asker(requester) {
    if (requester.from === "discord") {
        const name = requester.member ? clean(requester.member.displayName) : "Someone";
        return { who: name, asked: `${name} asked on Discord.` };
    }
    return { who: "Someone", asked: "Asked outside Discord." };
}
export function approvalTitle(who, name, place) {
    const build = (event, where) => `${who} wants to add **${event}** to ${where}`;
    const room = APPROVAL_TITLE_MAX - points(build("", place));
    if (room >= 1)
        return build(fit(name, room), place);
    return build("…", fit(place, APPROVAL_TITLE_MAX - points(build("…", ""))));
}
export function approvalDescription(asked, name, when, place) {
    const build = (event) => `${asked} ${event}, ${when}, on ${place}.`;
    return build(fit(name, APPROVAL_DESCRIPTION_MAX - points(build(""))));
}
export const createdLine = (name, place, when) => `Added **${name}** to ${place}, ${when}.`;
export const notApprovedLine = (name, approver) => `That didn't get approved, so I didn't add **${name}**. Ask again when ${approver} is around.`;
export const timedOutLine = (name, approver) => `Nobody answered in ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so I didn't add **${name}**. Ask again when ${approver} is around.`;
export const somethingWrongLine = (name) => `Something went wrong checking that, so I didn't add **${name}**.`;
/** The model relays deny and cancel itself: the host's result for those is its own text. */
export function calendarCreateDescription(config) {
    const approver = approverPhrase(config.members);
    const names = config.calendars.map((calendar) => clean(calendar.label)).join(", ");
    return (`Add one event to a family calendar. Calendars: ${names || "none set up"}. ` +
        "A timed event needs start and end as date-times with their UTC offset; an all-day event sets allDay and uses YYYY-MM-DD. " +
        `Some additions wait for ${approver} to approve them. Reply with the text this tool returns. ` +
        `If the addition isn't approved or is cancelled, say exactly: "${notApprovedLine("<event name>", approver)}" ` +
        "with the event's name in place of <event name>. Never pass on the host's own text, IDs, or /approve.");
}
// ---- The hook and the tool ----
async function logOutcome(deps, prepared, status) {
    const log = deps.log();
    if (!log)
        throw new Error("oc-family-pack: the family store is not running");
    await log.appendWriteLog({
        requestKey: requestKey(prepared.base, await log.countCommittedWrites(prepared.base)),
        baseKey: prepared.base,
        requester: prepared.tag,
        op: "create",
        calendarId: prepared.calendar.id,
        afterJson: loggedFields(prepared.normalized),
        status,
    }, { ifAbsent: false });
}
const OUTCOME = { deny: "denied", timeout: "timed-out", cancelled: "failed" };
/**
 * The permission table runs here, once per tool call: gate 0, off, read-only, table, confirm.
 * Every call that may run leaves with this hook's stamp in STAMP_PARAM, overwriting whatever
 * the model sent. A write that needs a parent asks the host for approval; the host only runs
 * the tool after allow-once. Outcome rows are written when the host reports the decision.
 */
export function calendarCreateHook(deps, stamper) {
    return async (event, ctx) => {
        if (event.toolName !== CALENDAR_CREATE_TOOL)
            return undefined;
        const params = withoutStamp(event.params);
        let prepared;
        try {
            prepared = prepareCreate(deps.config, factsFromHook(ctx), params);
        }
        catch (error) {
            if (error instanceof CreateInputError)
                return { block: true, blockReason: error.message };
            throw error;
        }
        const gate = gateWrite({
            writes: deps.config.writes,
            grant: deps.grant.get(),
            members: deps.config.members,
            requester: prepared.requester,
            calendar: prepared.calendar,
        });
        if (gate.decision === "refused")
            return { block: true, blockReason: gate.message };
        if (gate.decision === "write")
            return { params: { ...params, [STAMP_PARAM]: stamper.stamp(prepared.base, "write", CALENDAR_CREATE_TOOL) } };
        const name = clean(prepared.normalized.title);
        const place = calendarPlace(deps.config.members, prepared.calendar);
        const when = bernieWhen(prepared.normalized, deps.config.timezone);
        const { who, asked } = asker(prepared.requester);
        return {
            params: { ...params, [STAMP_PARAM]: stamper.stamp(prepared.base, "approved", CALENDAR_CREATE_TOOL) },
            requireApproval: {
                title: approvalTitle(who, name, place),
                description: approvalDescription(asked, name, when, place),
                severity: "info",
                timeoutMs: APPROVAL_TIMEOUT_MS,
                timeoutReason: timedOutLine(name, approverPhrase(deps.config.members)),
                allowedDecisions: ["allow-once", "deny"],
                async onResolution(decision) {
                    const status = OUTCOME[decision];
                    if (status)
                        await logOutcome(deps, prepared, status);
                },
            },
        };
    };
}
function reply(textValue, status) {
    return { content: [{ type: "text", text: textValue }], details: { status } };
}
/**
 * Runs only what the hook stamped. The key comes from the params the tool actually received;
 * a missing, forged or mismatched stamp (a later hook rewrote the call, or no hook ran) is
 * refused before gog and logged `failed`. After that, only gate 0, off and read-only run again.
 */
export function calendarCreateTool(deps, stamper, ctx) {
    return {
        name: CALENDAR_CREATE_TOOL,
        label: "Add to calendar",
        description: calendarCreateDescription(deps.config),
        parameters: CalendarCreateInputSchema,
        async execute(toolCallId, rawParams) {
            const stamp = typeof rawParams === "object" && rawParams !== null ? rawParams[STAMP_PARAM] : undefined;
            const params = withoutStamp(rawParams);
            let prepared;
            try {
                prepared = prepareCreate(deps.config, factsFromTool(ctx), params);
            }
            catch (error) {
                if (error instanceof CreateInputError)
                    return reply(error.message, "refused");
                throw error;
            }
            const name = clean(prepared.normalized.title);
            const table = stamper.verify(stamp, prepared.base, CALENDAR_CREATE_TOOL);
            if (table === undefined) {
                await logOutcome(deps, prepared, "failed");
                return reply(somethingWrongLine(name), "refused");
            }
            const log = deps.log();
            if (!log)
                throw new Error("oc-family-pack: the family store is not running");
            const context = { source: "tool", tool: ctx, toolCallId };
            const result = await submitCreate({ config: deps.config, runGog: deps.runGog, log, grant: deps.grant }, { context, calendar: prepared.calendar, fields: prepared.fields, table });
            // gog failed: calendar-write has logged `failed` and, for the read-only grant, flipped it.
            if (result.status === "failed")
                return reply(result.reason === "readonly" ? READ_ONLY : unreachableLine("create", name), "failed");
            if (result.status === "refused")
                return reply(result.message, "refused");
            if (result.status === "needs-approval")
                return reply(somethingWrongLine(name), "refused");
            return reply(createdLine(name, calendarPlace(deps.config.members, prepared.calendar), bernieWhen(prepared.normalized, deps.config.timezone)), result.status);
        },
    };
}
/** The hook and the tool, always together, sharing one stamp secret made here. No hook, no tool. */
export function registerCalendarWrite(api, deps) {
    const stamper = createStamper();
    api.on("before_tool_call", calendarCreateHook(deps, stamper), { priority: CALENDAR_HOOK_PRIORITY, matcher: [CALENDAR_CREATE_TOOL] });
    api.registerTool((ctx) => calendarCreateTool(deps, stamper, ctx), { name: CALENDAR_CREATE_TOOL });
}
