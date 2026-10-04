import type { RunGog } from "./calendar-gog.ts";
import { alertDeliveryFailure } from "./briefs.ts";
import { longDay } from "./brief.ts";
import { DEMO_CALENDARS, DEMO_MEMBERS } from "./demo.ts";
import type { DeliveryOutcome, DeliveryTarget, DiscordMessage } from "./discord-delivery.ts";
import {
  afterSchoolLines,
  dayIsClosed,
  dueHousehold,
  householdMessage,
  inclusiveDays,
  morningLines,
  sundayOnOrAfter,
  weekendLines,
  type DueHousehold,
  type HouseholdItem,
  type HouseholdKind,
  type HouseholdSection,
} from "./household.ts";
import { buildSchedule, readEvents, type ReadEvent } from "./schedule.ts";
import type { DeliveryKind, DeliveryLogRow, DeliveryStatus, FamilyStore } from "./store.ts";
import type { Config, ScheduleInput, ScheduleOutput } from "./types.ts";
import { addDays, localDate } from "./week.ts";

type Deliver = (target: DeliveryTarget, messages: readonly DiscordMessage[], key: string) => Promise<DeliveryOutcome>;
type Store = Pick<FamilyStore, "appendDeliveryLog" | "deliveryDone" | "deliveryStreakStart">;

/** Start, end, and place for one event. `family_schedule` items do not carry these. */
export type Detail = {
  id: string;
  title: string;
  date: string;
  allDay: boolean;
  minutes?: number;
  endMinutes?: number;
  location?: string;
};

export type HouseholdDeps = {
  config: Config;
  store: () => Store | undefined;
  deliver: Deliver;
  runGog?: RunGog;
  /** Defaults to `buildSchedule` as the owner, which is the `family_schedule` read. */
  schedule?: (input: ScheduleInput, now: number) => ScheduleOutput | Promise<ScheduleOutput>;
  /** Defaults to the same calendar read. `undefined` means the read failed and the tick tries again. */
  details?: (start: string, end: string) => Detail[] | undefined | Promise<Detail[] | undefined>;
  log: (line: string) => void;
};

const TICK_MS = 60_000;
const TITLE: Record<HouseholdKind, string> = { morning: "Morning", "after-school": "After school", weekend: "Weekend" };

function minutesOf(instant: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  return (hour === 24 ? 0 : hour) * 60 + Number(parts.minute);
}

export function toDetail(event: ReadEvent, timezone: string): Detail {
  if (event.allDay) {
    return { id: event.id, title: event.title, date: event.start, allDay: true, ...(event.location === undefined ? {} : { location: event.location }) };
  }
  const start = Date.parse(event.start);
  const date = localDate(start, timezone);
  const minutes = minutesOf(start, timezone);
  let endMinutes: number | undefined;
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

function itemsOf(output: ScheduleOutput, details: readonly Detail[]): HouseholdItem[] {
  if (!("sections" in output)) return [];
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const items: HouseholdItem[] = [];
  for (const section of output.sections) {
    if (section.name === "matches") continue;
    for (const item of section.items) {
      const detail = byId.get(item.id);
      if (detail === undefined) continue;
      const named = section.name as HouseholdSection;
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

function rowOf(key: string, target: string, outcome: DeliveryOutcome): DeliveryLogRow {
  const kind: DeliveryKind = "household";
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

function alertLine(kind: HouseholdKind, date: string, status: Exclude<DeliveryStatus, "sent">): string {
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

function rangeFor(job: DueHousehold): { start: string; end: string; days: number } {
  if (job.kind === "morning") return { start: job.date, end: addDays(job.date, 1), days: 2 };
  if (job.kind === "after-school") return { start: job.date, end: job.date, days: 1 };
  const end = sundayOnOrAfter(job.date);
  return { start: job.date, end, days: inclusiveDays(job.date, end) };
}

async function defaultSchedule(deps: HouseholdDeps, input: ScheduleInput, now: number): Promise<ScheduleOutput> {
  return buildSchedule(deps.config, input, { viewer: { kind: "owner" } }, now, deps.runGog);
}

async function defaultDetails(deps: HouseholdDeps, start: string, end: string): Promise<Detail[] | undefined> {
  const calendars = deps.config.demo ? DEMO_CALENDARS : deps.config.calendars;
  try {
    const read = await readEvents(deps.config, calendars, { range: { start, end, timezone: deps.config.timezone } }, deps.runGog);
    if (read.status !== "ok") return undefined;
    return read.data.map((event) => toDetail(event, deps.config.timezone));
  } catch {
    return undefined;
  }
}

async function sendOne(
  deps: HouseholdDeps,
  store: Store,
  job: DueHousehold,
  target: DeliveryTarget,
  targetId: string,
  message: DiscordMessage,
  outcome: DeliveryOutcome | undefined,
): Promise<void> {
  const key = job.kind === "morning" ? `${job.key}:${targetId}` : job.key;
  if (await store.deliveryDone(key)) return;
  const result = outcome ?? (await deps.deliver(target, [message], key));
  const row = rowOf(key, targetId, result);
  await store.appendDeliveryLog(row);
  if (row.status !== "sent") {
    deps.log(`oc-family-pack: household brief ${key} logged ${row.status} (${row.errorKind})`);
    await alertDeliveryFailure(deps, store, "household", targetId, (status) => alertLine(job.kind, job.date, status));
  }
}

async function runJob(deps: HouseholdDeps, store: Store, job: DueHousehold, now: number): Promise<void> {
  const { start, end, days } = rangeFor(job);
  const schedule = deps.schedule ?? ((input, at) => defaultSchedule(deps, input, at));
  const detailsOf = deps.details ?? ((from, to) => defaultDetails(deps, from, to));
  let output: ScheduleOutput;
  try {
    output = await schedule({ start, days }, now);
  } catch {
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
  const lines =
    job.kind === "morning"
      ? morningLines(items, job.date, hints)
      : job.kind === "after-school"
        ? afterSchoolLines(items, job.date, dayIsClosed(details.map((detail) => detail.title), deps.config.closedDayPhrases ?? []), usual)
        : weekendLines(items, job.date, end);
  if (lines === undefined || lines.length === 0) return;

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
export async function householdTick(deps: HouseholdDeps, now: number): Promise<void> {
  const store = deps.store();
  if (!store) return;
  for (const job of dueHousehold(now, deps.config)) {
    await runJob(deps, store, job, now);
  }
}

/** Polls every minute from now; ticks never overlap. Returns the stop function. */
export function startHouseholds(deps: HouseholdDeps, now: () => number = Date.now): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await householdTick(deps, now());
    } catch (error) {
      deps.log(`oc-family-pack: household tick failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
