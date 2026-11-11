import { changeLine, ChangeInputError, NO_SUCH_EVENT, readChange } from "./calendar-change.js";
import { approverPhrase, bernieWhen, calendarPlace, clean, createdLine, extraFields, failedLine, notApprovedLine } from "./calendar-create.js";
import { checkKey, getEvent, normalizeCreate, somethingWrongLine, submitChange, submitCreate, END_BEFORE_START } from "./calendar-write.js";
import { CalendarWriteSchema } from "./contract.js";
import { memoryOf, resolveWriteSource } from "./identity.js";
import { visibleCalendarIds } from "./visibility.js";
/** The page's one write action. The answer is ux's line only: no event id, no key, no gog or store text. */
export function pageWrite(deps) {
    return async (input, context, pageRequester, requestViewer) => {
        const op = input.op;
        if (deps.config.demo)
            return { ok: false, message: somethingWrongLine(op, undefined) };
        try {
            checkKey(input.requestId);
        }
        catch {
            return { ok: false, message: somethingWrongLine(op, input.op === "create" ? clean(input.title) : undefined) };
        }
        // The host checks the action's input schema; this holds its shape without that check, like the tools.
        const variant = CalendarWriteSchema.anyOf.find((entry) => entry.properties.op.const === op);
        if (!variant || extraFields(variant, input).length > 0)
            return { ok: false, message: somethingWrongLine(op, undefined) };
        const log = deps.log();
        const submitDeps = (store) => ({
            config: deps.config,
            runGog: deps.runGog,
            grant: deps.grant,
            log: store,
            ...(pageRequester !== undefined ? { requester: pageRequester } : {}),
        });
        const visible = visibleCalendarIds(deps.config, requestViewer);
        const approver = approverPhrase(deps.config.members);
        if (input.op === "create") {
            const name = clean(input.title);
            const calendar = deps.config.calendars.find((entry) => entry.key === input.calendarKey);
            if (!calendar)
                return { ok: false, message: `I couldn't find that calendar, so I didn't add **${name}**.` };
            if (visible !== undefined && !visible.has(calendar.id))
                return { ok: false, message: somethingWrongLine("create", name) };
            if (!log)
                return { ok: false, message: somethingWrongLine("create", name) };
            const fields = {
                title: input.title,
                start: input.start,
                end: input.end,
                ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
                ...(input.location !== undefined ? { location: input.location } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
            };
            let when;
            try {
                when = bernieWhen(normalizeCreate(fields), deps.config.timezone);
            }
            catch (error) {
                return { ok: false, message: error instanceof Error && error.message === END_BEFORE_START ? END_BEFORE_START : `I couldn't read that date or time, so I didn't add **${name}**.` };
            }
            const result = await submitCreate(submitDeps(log), { context, payload: input, calendar, fields });
            if (result.status === "refused")
                return { ok: false, message: result.message };
            if (result.status === "needs-approval")
                return { ok: false, message: notApprovedLine(name, approver, "create") };
            if (result.status === "failed")
                return { ok: false, message: failedLine("create", result.reason, name) };
            deps.changed([calendar.key]);
            return { ok: true, message: createdLine(name, calendarPlace(deps.config.members, calendar), when) };
        }
        const changeOp = input.op;
        let target;
        try {
            const { op: _op, id, requestId: _requestId, ...rest } = input;
            target = readChange(deps.config.calendars, changeOp, { ...rest, event: id, ...(input.op === "move" ? { calendar: input.destinationKey } : {}) });
        }
        catch (error) {
            if (error instanceof ChangeInputError)
                return { ok: false, message: error.message };
            throw error;
        }
        if (visible !== undefined &&
            (!visible.has(target.calendar.id) || (target.destination !== undefined && !visible.has(target.destination.id)))) {
            return { ok: false, message: NO_SUCH_EVENT };
        }
        if (!log)
            return { ok: false, message: somethingWrongLine(changeOp, undefined) };
        const memory = memoryOf(deps.identity?.());
        if (memory) {
            const book = await memory.identityBook();
            const bound = book.sources.find((source) => source.calendarKey === target.calendar.key && source.eventId === target.eventId);
            const sources = bound ? book.sources.filter((source) => source.fpId === bound.fpId) : [{ calendarKey: target.calendar.key, eventId: target.eventId }];
            const authorized = new Set(deps.config.calendars.filter((calendar) => visible === undefined || visible.has(calendar.id)).map((calendar) => calendar.key));
            const chosen = resolveWriteSource({ calendarKey: target.calendar.key, eventId: target.eventId }, sources, authorized);
            if (!chosen)
                return { ok: false, message: NO_SUCH_EVENT };
            if (chosen.calendarKey !== target.calendar.key || chosen.eventId !== target.eventId) {
                const calendar = deps.config.calendars.find((entry) => entry.key === chosen.calendarKey);
                if (!calendar)
                    return { ok: false, message: NO_SUCH_EVENT };
                target.calendar = calendar;
                target.eventId = chosen.eventId;
            }
        }
        const result = await submitChange(submitDeps(log), {
            context,
            payload: input,
            op: changeOp,
            calendar: target.calendar,
            eventId: target.eventId,
            ...(target.fields ? { fields: target.fields } : {}),
            ...(target.destination ? { destination: target.destination } : {}),
            ...(target.series ? { series: target.series } : {}),
        });
        if (result.status === "needs-approval") {
            // Only for the name in the line; nothing is written.
            const found = await getEvent(deps, target.calendar.id, target.eventId).catch(() => undefined);
            return { ok: false, message: found?.event ? notApprovedLine(clean(found.event.title), approver, changeOp) : NO_SUCH_EVENT };
        }
        const line = changeLine(deps.config, target, result);
        const ok = result.status === "changed" || result.status === "existing";
        if (ok)
            deps.changed([target.calendar.key, ...(target.destination ? [target.destination.key] : [])]);
        return { ok, message: line.text };
    };
}
