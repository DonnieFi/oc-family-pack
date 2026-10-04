import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Type } from "typebox";
import { STAMP_PARAM, type Stamper } from "./approval-stamp.ts";
import {
  APPROVAL_TIMEOUT_MS,
  APPROVAL_TITLE_MAX,
  approvalDescription,
  approvalTitle,
  approverPhrase,
  asker,
  bernieWhen,
  calendarPlace,
  clean,
  extraFields,
  factsFromHook,
  factsFromTool,
  failedLine,
  fit,
  logOutcome,
  notApprovedLine,
  reply,
  timedOutLine,
  moveApprovalDescription,
  withoutStamp,
  type CalendarTool,
  type CalendarWriteDeps,
  type HookContext,
  type HookEvent,
  type HookResult,
  type KeyFacts,
  type ToolContext,
} from "./calendar-create.ts";
import {
  applyChange,
  changeBaseKey,
  checkKey,
  END_BEFORE_START,
  END_BEFORE_START_CHANGE,
  getEvent,
  normalizeChange,
  NOTHING_TO_CHANGE,
  requesterTag,
  requestKey,
  somethingWrongLine,
  submitChange,
  unreachableLine,
  type ChangeFields,
  type ChangeOp,
  type EventFields,
  type SeriesScope,
  type SubmitChangeResult,
} from "./calendar-write.ts";
import { writeRequesterFromFacts, type Requester } from "./requester.ts";
import type { CalendarConfig, Config } from "./types.ts";
import { gateWrite } from "./write-gate.ts";

export const CALENDAR_UPDATE_TOOL = "calendar_update";
export const CALENDAR_MOVE_TOOL = "calendar_move";
export const CALENDAR_DELETE_TOOL = "calendar_delete";
export const CHANGE_TOOLS: Readonly<Record<string, ChangeOp>> = { [CALENDAR_UPDATE_TOOL]: "update", [CALENDAR_MOVE_TOOL]: "move", [CALENDAR_DELETE_TOOL]: "delete" };

const EventParam = Type.String({ minLength: 3, maxLength: 1100, description: "The event's id from family_schedule, such as c0/abc123." });
const SeriesParam = Type.Optional(
  Type.Union([Type.Literal("single"), Type.Literal("future"), Type.Literal("all")], {
    description: "For a repeating event: just this one (the default), this one and every later one, or all of them.",
  }),
);
const when = (what: string) =>
  Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: `${what}: a date and time with its UTC offset, or YYYY-MM-DD for an all-day event.` }));

export const CalendarUpdateInputSchema = Type.Object(
  {
    event: EventParam,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    start: when("The new start"),
    end: when("The new end"),
    allDay: Type.Optional(Type.Boolean()),
    location: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    scope: SeriesParam,
  },
  { additionalProperties: false },
);
export const CalendarMoveInputSchema = Type.Object(
  {
    event: EventParam,
    calendar: Type.String({ minLength: 1, maxLength: 100, description: "The calendar it moves to, by the name listed in this tool's description." }),
  },
  { additionalProperties: false },
);
export const CalendarDeleteInputSchema = Type.Object({ event: EventParam, scope: SeriesParam }, { additionalProperties: false });

// ---- What people read ----

/** For a wire id that names no calendar here, or an event Google has no record of. */
export const NO_SUCH_EVENT = "I couldn't find that event, so nothing changed.";
export const NOTHING_CHANGED = "I wasn't sure what to change, so I left it alone.";
export const UNREADABLE_TIME = "I couldn't read that date or time, so nothing changed.";

export const changedLine = (name: string, place: string, now: string) => `Changed **${name}** on ${place}. It's now ${now}.`;
export const rescheduledLine = (name: string, place: string, now: string, was: string) => `Moved **${name}** on ${place} to ${now}. It was ${was}.`;
export const deletedLine = (name: string, place: string, was: string) => `Deleted **${name}** from ${place}. It was ${was}.`;
export const seriesLine = (op: "update" | "delete", name: string, place: string, from: string) =>
  `${op === "update" ? "Changed" : "Deleted"} every **${name}** on ${place} from ${from} on.`;
export const notFoundLine = (name: string, place: string) => `I couldn't find **${name}** on ${place}, so nothing changed.`;
/** A move between calendars keeps the event's time, and says so. */
export const movedBetweenLine = (name: string, from: string, to: string, when: string) => `Moved **${name}** from ${from} to ${to}. It's still ${when}.`;

/** "Tuesday October 13": the day an instant falls on in the family's timezone. */
function longDate(at: string, timezone: string): string {
  if (!at.includes("T")) return bernieWhen({ start: at, allDay: true }, timezone);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  return bernieWhen({ start: day, allDay: true }, timezone);
}

/** The change asks for a new start, end or all-day. */
function timeChanges(fields: ChangeFields | undefined): boolean {
  return fields?.start !== undefined || fields?.end !== undefined || fields?.allDay !== undefined;
}

/** Only the time moved: nothing but start, end or all-day was asked for. */
function onlyTime(fields: ChangeFields | undefined): boolean {
  const keys = Object.keys(fields ?? {});
  return keys.length > 0 && keys.every((key) => key === "start" || key === "end" || key === "allDay");
}

export type ChangeTarget = {
  op: ChangeOp;
  calendar: CalendarConfig;
  destination?: CalendarConfig;
  fields?: ChangeFields;
};

/** The line for a change's result. Never an id, a key, or a word about duplicates. */
export function changeLine(config: Pick<Config, "members" | "timezone">, target: ChangeTarget, result: SubmitChangeResult): { text: string; status: string } {
  const place = calendarPlace(config.members, target.calendar);
  const whenOf = (fields: EventFields) => bernieWhen(fields, config.timezone);
  switch (result.status) {
    case "refused":
      return { text: result.message, status: "refused" };
    case "invalid":
      return { text: result.message, status: "refused" };
    case "needs-approval":
      return { text: somethingWrongLine(target.op, undefined), status: "refused" };
    case "not-found":
      return { text: result.title ? notFoundLine(clean(result.title), place) : NO_SUCH_EVENT, status: "not-found" };
    case "failed":
      return { text: failedLine(target.op, result.reason, result.title ? clean(result.title) : undefined), status: "failed" };
  }
  const name = clean(result.after.title);
  if (result.seriesFrom && target.op !== "move") return { text: seriesLine(target.op, name, place, longDate(result.seriesFrom, config.timezone)), status: result.status };
  if (target.op === "delete") return { text: deletedLine(name, place, whenOf(result.before)), status: result.status };
  if (target.op === "move") {
    const to = target.destination ? calendarPlace(config.members, target.destination) : place;
    return { text: movedBetweenLine(name, place, to, whenOf(result.before)), status: result.status };
  }
  if (onlyTime(target.fields)) return { text: rescheduledLine(name, place, whenOf(result.after), whenOf(result.before)), status: result.status };
  return { text: changedLine(name, place, whenOf(result.after)), status: result.status };
}

// ---- From a call to a change ----

/** A problem with what was asked for. The message is for the person. */
export class ChangeInputError extends Error {}

/** `c0/<Google event id>`: a calendar this family has, and an id with no space, slash or control character. */
export function resolveWireId(calendars: readonly CalendarConfig[], wire: unknown): { calendar: CalendarConfig; eventId: string } | undefined {
  if (typeof wire !== "string") return undefined;
  const slash = wire.indexOf("/");
  if (slash <= 0) return undefined;
  const calendar = calendars.find((entry) => entry.key === wire.slice(0, slash));
  const eventId = wire.slice(slash + 1);
  if (!calendar || !/^[^\s/\p{Cc}\p{Cf}]{1,1024}$/u.test(eventId)) return undefined;
  return { calendar, eventId };
}

function findCalendar(calendars: readonly CalendarConfig[], name: string): CalendarConfig | undefined {
  const wanted = name.trim().toLowerCase();
  return calendars.find((calendar) => calendar.key.toLowerCase() === wanted || calendar.label.trim().toLowerCase() === wanted);
}

const text = (params: Record<string, unknown>, name: string) => (typeof params[name] === "string" ? (params[name] as string) : undefined);

/** What a change call asks for, before who asked: shared by the tools and the page. */
export function readChange(calendars: readonly CalendarConfig[], op: ChangeOp, input: Record<string, unknown>): ChangeTarget & { eventId: string; series?: SeriesScope } {
  const wire = resolveWireId(calendars, input.event);
  if (!wire) throw new ChangeInputError(NO_SUCH_EVENT);
  const target: ChangeTarget & { eventId: string; series?: SeriesScope } = { op, calendar: wire.calendar, eventId: wire.eventId };
  const series = input.scope;
  if (series === "single" || series === "future" || series === "all") target.series = series;
  if (op === "move") {
    const name = text(input, "calendar") ?? "";
    const destination = findCalendar(calendars, name);
    if (!destination) throw new ChangeInputError(`I couldn't find a calendar called ${clean(name)}, so nothing changed.`);
    target.destination = destination;
  }
  if (op === "update") {
    const fields: ChangeFields = {};
    for (const name of ["title", "start", "end", "location", "description"] as const) {
      const value = text(input, name);
      if (value !== undefined) fields[name] = value;
    }
    if (typeof input.allDay === "boolean") fields.allDay = input.allDay;
    target.fields = fields;
  }
  return target;
}

export type PreparedChange = ChangeTarget & { eventId: string; series?: SeriesScope; base: string; tag: string; requester: Requester };

/** The hook's and the tool's one way to a change's key: the same `changeBaseKey` the write log uses. */
export function prepareChange(setup: Pick<Config, "members" | "calendars">, facts: KeyFacts, op: ChangeOp, params: unknown): PreparedChange {
  const input = withoutStamp(params);
  if (extraFields(SCHEMAS[op], input).length > 0) throw new ChangeInputError(somethingWrongLine(op, undefined));
  const target = readChange(setup.calendars, op, input);
  const scope = facts.sessionKey && facts.sessionKey.trim() ? facts.sessionKey : undefined;
  if (scope === undefined) throw new ChangeInputError(somethingWrongLine(op, undefined));
  const requester = writeRequesterFromFacts(setup.members, facts);
  const tag = requesterTag(requester);
  let base: string;
  try {
    base = changeBaseKey({
      requester: tag,
      scope: checkKey(scope),
      op,
      calendarId: target.calendar.id,
      eventId: target.eventId,
      ...(target.fields ? { fields: target.fields } : {}),
      ...(target.destination ? { destinationId: target.destination.id } : {}),
      ...(target.series ? { series: target.series } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === NOTHING_TO_CHANGE) throw new ChangeInputError(NOTHING_CHANGED);
    if (message === END_BEFORE_START) throw new ChangeInputError(END_BEFORE_START_CHANGE);
    if (op === "update" && /time/i.test(message)) throw new ChangeInputError(UNREADABLE_TIME);
    throw new ChangeInputError(somethingWrongLine(op, undefined));
  }
  return { ...target, base, tag, requester };
}

function changeOutcome(prepared: PreparedChange, beforeJson?: string) {
  return async () => ({
    requestKey: requestKey(prepared.base, 0),
    baseKey: prepared.base,
    requester: prepared.tag,
    op: prepared.op,
    calendarId: prepared.calendar.id,
    eventId: prepared.eventId,
    ...(beforeJson ? { beforeJson } : {}),
  });
}

const OUTCOME = { deny: "denied", timeout: "timed-out", cancelled: "failed" } as const;

/**
 * The change tools' half of the before_tool_call hook: the same gate as a create (a move's
 * destination too), then a stamp. A change that needs a parent reads the event first, so the
 * approval names it and says when it is.
 */
export function calendarChangeHook(deps: CalendarWriteDeps, stamper: Stamper) {
  return async (event: HookEvent, ctx: HookContext): Promise<HookResult | undefined> => {
    const op = CHANGE_TOOLS[event.toolName];
    if (!op) return undefined;
    const params = withoutStamp(event.params);
    let prepared: PreparedChange;
    try {
      prepared = prepareChange(deps.config, factsFromHook(ctx), op, params);
    } catch (error) {
      if (error instanceof ChangeInputError) return { block: true, blockReason: error.message };
      throw error;
    }
    const gate = gateWrite({
      writes: deps.config.writes,
      grant: deps.grant.get(),
      members: deps.config.members,
      requester: prepared.requester,
      calendar: prepared.calendar,
      ...(prepared.destination ? { destination: prepared.destination } : {}),
    });
    if (gate.decision === "refused") return { block: true, blockReason: gate.message };
    if (gate.decision === "write") return { params: { ...params, [STAMP_PARAM]: stamper.stamp(prepared.base, "write", event.toolName) } };
    const place = calendarPlace(deps.config.members, prepared.calendar);
    let found: Awaited<ReturnType<typeof getEvent>>;
    try {
      found = await getEvent(deps, prepared.calendar.id, prepared.eventId);
    } catch {
      return { block: true, blockReason: unreachableLine(op, undefined) };
    }
    if (found.status !== "found") return { block: true, blockReason: found.event ? notFoundLine(clean(found.event.title), place) : NO_SUCH_EVENT };
    const name = clean(found.event.title);
    // The tool refuses the change if the event has another version by then (arch, s5k.28).
    const version = found.version;
    if (!version) return { block: true, blockReason: somethingWrongLine(op, name) };
    const where = prepared.destination ? calendarPlace(deps.config.members, prepared.destination) : place;
    const when = bernieWhen(found.event, deps.config.timezone);
    const movesTo = op === "update" && prepared.fields && timeChanges(prepared.fields) ? bernieWhen(applyChange(found.event, normalizeChange(prepared.fields)), deps.config.timezone) : undefined;
    const { who, asked } = asker(prepared.requester);
    const beforeJson = JSON.stringify({
      summary: found.event.title,
      start: found.event.start,
      end: found.event.end,
      allDay: found.event.allDay,
      ...(found.event.location ? { location: found.event.location } : {}),
    });
    return {
      params: { ...params, [STAMP_PARAM]: stamper.stamp(prepared.base, "approved", event.toolName, { version, title: fit(clean(found.event.title), APPROVAL_TITLE_MAX) }) },
      requireApproval: {
        title: approvalTitle(who, name, where, op),
        description: op === "move" ? moveApprovalDescription(asked, name, when, place, where) : approvalDescription(asked, name, when, place, movesTo),
        severity: "info",
        timeoutMs: APPROVAL_TIMEOUT_MS,
        timeoutReason: timedOutLine(name, approverPhrase(deps.config.members), op),
        allowedDecisions: ["allow-once", "deny"],
        async onResolution(decision) {
          const status = decision in OUTCOME ? OUTCOME[decision as keyof typeof OUTCOME] : undefined;
          if (status) await logOutcome(deps, changeOutcome(prepared, beforeJson), status);
        },
      },
    };
  };
}

export function changeToolDescription(op: ChangeOp, config: Pick<Config, "members" | "calendars">): string {
  const approver = approverPhrase(config.members);
  const names = config.calendars.map((calendar) => clean(calendar.label)).join(", ");
  const what = {
    update: "Change one event on a family calendar: its name, time, place or notes. Pass only what changes.",
    move: `Move one event to another family calendar. Calendars: ${names || "none set up"}.`,
    delete: "Delete one event from a family calendar.",
  }[op];
  return (
    `${what} The event is the id family_schedule gives it. ` +
    `Some changes wait for ${approver} to approve them. Reply with the text this tool returns. ` +
    `If the change isn't approved or is cancelled, say exactly: "${notApprovedLine("<event name>", approver, op)}" ` +
    "with the event's name in place of <event name>. Never pass on the host's own text, IDs, or /approve."
  );
}

const SCHEMAS = { update: CalendarUpdateInputSchema, move: CalendarMoveInputSchema, delete: CalendarDeleteInputSchema };
const LABELS = { update: "Change a calendar event", move: "Move a calendar event", delete: "Delete a calendar event" };
export const TOOL_OF: Readonly<Record<ChangeOp, string>> = { update: CALENDAR_UPDATE_TOOL, move: CALENDAR_MOVE_TOOL, delete: CALENDAR_DELETE_TOOL };

/** Runs only what the hook stamped, like calendar_create. */
export function calendarChangeTool(op: ChangeOp, deps: CalendarWriteDeps, stamper: Stamper, ctx: ToolContext): CalendarTool {
  const name = TOOL_OF[op];
  return {
    name,
    label: LABELS[op],
    description: changeToolDescription(op, deps.config),
    parameters: SCHEMAS[op],
    async execute(toolCallId, rawParams) {
      const stamp = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>)[STAMP_PARAM] : undefined;
      const params = withoutStamp(rawParams);
      let prepared: PreparedChange;
      try {
        prepared = prepareChange(deps.config, factsFromTool(ctx), op, params);
      } catch (error) {
        if (error instanceof ChangeInputError) return reply(error.message, "refused");
        throw error;
      }
      const opened = stamper.open(stamp, prepared.base, name);
      // An empty version goes only with a direct write: an approved change always carries what the hook read.
      if (opened === undefined || (opened.decision === "approved" && !opened.seen?.version)) {
        await logOutcome(deps, changeOutcome(prepared), "failed");
        return reply(somethingWrongLine(op, undefined), "refused");
      }
      const log = deps.log();
      if (!log) return reply(somethingWrongLine(op, undefined), "failed");
      const context = { source: "tool", tool: ctx, toolCallId } as unknown as FeatureInvocationContext;
      const result = await submitChange(
        { config: deps.config, runGog: deps.runGog, log, grant: deps.grant },
        {
          context,
          op,
          calendar: prepared.calendar,
          eventId: prepared.eventId,
          table: opened.decision,
          ...(opened.seen ? { approved: opened.seen } : {}),
          ...(prepared.fields ? { fields: prepared.fields } : {}),
          ...(prepared.destination ? { destination: prepared.destination } : {}),
          ...(prepared.series ? { series: prepared.series } : {}),
        },
      );
      const line = changeLine(deps.config, prepared, result);
      return reply(line.text, line.status);
    },
  };
}
