import type { RunGog } from "./calendar-gog.ts";
import { dailyEmbed, longDay, weeklyEmbed, type BriefEvent } from "./brief.ts";
import { DEMO_CALENDARS, DEMO_MEMBERS } from "./demo.ts";
import { type DeliveryDirectory, type DeliveryOutcome, type DeliveryTarget, type DiscordMessage } from "./discord-delivery.ts";
import type { Collection } from "./garbage.ts";
import { groupCopies, mergeGroup } from "./merge.ts";
import { readEvents, type ReadEvent } from "./schedule.ts";
import type { DeliveryKind, DeliveryLogRow, DeliveryStatus, FamilyStore } from "./store.ts";
import type { CalendarStateOf, Config, WeatherCard } from "./types.ts";
import { addDays, localDate, localTime } from "./week.ts";

type Deliver = (target: DeliveryTarget, messages: readonly DiscordMessage[], key: string) => Promise<DeliveryOutcome>;
type Store = Pick<FamilyStore, "appendDeliveryLog" | "deliveryDone" | "deliveryStreakStart">;

export type BriefDeps = {
  config: Config;
  /** The store once its service has started; a tick before then does nothing. */
  store: () => Store | undefined;
  /** `deliver` bound to the host's send and config. */
  deliver: Deliver;
  /** The chat agent's name for the daily footer. */
  agentName: () => Promise<string>;
  readCalendars?: (config: Config, span: { range: { start: string; end: string; timezone: string } }) => Promise<CalendarStateOf<ReadEvent>>;
  readWeather: () => Promise<WeatherCard | undefined>;
  garbageTomorrow: (now: number) => Promise<Collection | undefined>;
  log: (line: string) => void;
};

/** Bernie's 07:00 daily and Sunday 20:00 weekly (jobs/bts_registration.py:92-103, :162-173), in the household zone. */
const DAILY_HOUR = 7;
const WEEKLY_HOUR = 20;
/** A brief not sent by noon is stale: the daily on its own date, the weekly on the Monday it covers. */
const WINDOW_END_HOUR = 12;
const TICK_MS = 60_000;

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export type DueBrief = { kind: "daily"; key: string; date: string } | { kind: "weekly"; key: string; monday: string };

/** Briefs whose send window holds `now`. A restart inside a window sends once; after it, never. */
export function dueBriefs(now: number, timezone: string): DueBrief[] {
  const today = localDate(now, timezone);
  const due: DueBrief[] = [];
  if (localTime(today, DAILY_HOUR, timezone) <= now && now < localTime(today, WINDOW_END_HOUR, timezone)) {
    due.push({ kind: "daily", key: `daily-summary:${today}`, date: today });
  }
  const sunday = weekday(today) === 0 ? today : weekday(today) === 1 ? addDays(today, -1) : undefined;
  if (sunday !== undefined) {
    const monday = addDays(sunday, 1);
    if (localTime(sunday, WEEKLY_HOUR, timezone) <= now && now < localTime(monday, WINDOW_END_HOUR, timezone)) {
      due.push({ kind: "weekly", key: `weekly-summary:${monday}`, monday });
    }
  }
  return due;
}

/** Calendar events for the brief, copies merged, each with its calendar's kind and owners' names. */
async function briefEvents(deps: BriefDeps, start: string, end: string): Promise<BriefEvent[] | undefined> {
  const { config } = deps;
  const members = config.demo ? DEMO_MEMBERS : config.members;
  const calendars = config.demo ? DEMO_CALENDARS : config.calendars;
  const span = { range: { start, end, timezone: config.timezone } };
  const read = await (deps.readCalendars ?? ((cfg, range) => readEvents(cfg, calendars, range)))(config, span);
  if (read.status !== "ok") return undefined;
  const byKey = new Map(calendars.map((calendar) => [calendar.key, calendar]));
  const order = new Map(members.map((member, index) => [member.profileId, index]));
  const names = new Map(members.map((member) => [member.profileId, member.displayName]));
  return groupCopies(read.data.filter((event) => byKey.has(event.calendarKey))).map((group) => {
    const event = mergeGroup(group);
    const calendar = byKey.get(event.calendarKey)!;
    const owners = [...new Set(group.flatMap((copy) => byKey.get(copy.calendarKey)!.owners))]
      .filter((id) => names.has(id))
      .sort((a, b) => order.get(a)! - order.get(b)!)
      .map((id) => names.get(id)!);
    return {
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      calendarKind: calendar.kind,
      owners,
      ...(event.location === undefined ? {} : { location: event.location }),
      ...(event.google?.description === undefined ? {} : { description: event.google.description }),
      ...(event.google?.recurringEventId === undefined ? {} : { recurringEventId: event.google.recurringEventId }),
      ...(event.google?.originalStart === undefined ? {} : { originalStart: event.google.originalStart }),
    };
  });
}

async function quietly<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** Weather and garbage are extras: a failed read drops their lines, and the brief still goes on time. */
async function buildBrief(deps: BriefDeps, brief: DueBrief, now: number): Promise<DiscordMessage | undefined> {
  const timezone = deps.config.timezone;
  if (brief.kind === "weekly") {
    const events = await briefEvents(deps, brief.monday, addDays(brief.monday, 6));
    return events && { embed: weeklyEmbed(brief.monday, timezone, events) };
  }
  const [events, weather, garbage, agentName] = await Promise.all([
    briefEvents(deps, brief.date, brief.date),
    quietly(deps.readWeather),
    quietly(() => deps.garbageTomorrow(now)),
    deps.agentName(),
  ]);
  if (!events) return undefined;
  return {
    embed: dailyEmbed({
      date: brief.date,
      timezone,
      events,
      agentName,
      ...(weather ? { weather } : {}),
      ...(garbage ? { garbage: { icon: garbage.icon, summary: garbage.summary } } : {}),
    }),
  };
}

function rowOf(key: string, kind: DeliveryKind, target: string, outcome: DeliveryOutcome): DeliveryLogRow {
  switch (outcome.status) {
    case "sent":
      return { deliveryKey: key, kind, target, status: "sent", receiptJson: JSON.stringify(outcome.receipt) };
    case "partial":
      return { deliveryKey: key, kind, target, status: "partial", errorKind: outcome.errorKind, errorDetail: outcome.detail, receiptJson: JSON.stringify(outcome.receipt) };
    case "claimed":
      // The host already holds this key: sent before, in flight, or lost in a crash mid-send.
      return { deliveryKey: key, kind, target, status: "unknown", errorKind: "other", errorDetail: "host already holds this delivery key (claimed)" };
    default:
      return { deliveryKey: key, kind, target, status: outcome.status, errorKind: outcome.errorKind, errorDetail: outcome.detail };
  }
}

const LABEL: Record<DeliveryKind, string> = { daily: "daily brief", weekly: "weekly brief", reminder: "reminder", household: "household brief", alert: "alert" };

/** DRAFT alert lines, one per status of the streak's first row; ux owns the wording (s5k.35.1). */
export function alertText(brief: DueBrief, status: Exclude<DeliveryStatus, "sent">): string {
  const what = brief.kind === "daily" ? `The daily brief for ${longDay(brief.date)}` : `The weekly brief for the week of ${longDay(brief.monday)}`;
  switch (status) {
    case "failed":
      return `${what} was not posted: Family has no Discord id for it in config.`;
    case "held":
      return `${what} has not gone out yet: Discord could not be reached. It may still go out later.`;
    case "partial":
      return `${what} was only partly posted.`;
    case "unknown":
      return `${what} may not have been posted. Check the channel in Discord.`;
  }
}

/**
 * One alert per parent per streak: the streak is the rows since the last sent one for (kind, target),
 * named by its first row's id, so a second failure in the same streak finds the alert already done.
 * Alert rows are logged as kind alert and never raise alerts of their own. The line is the streak's
 * first status, not the latest attempt.
 */
export async function alertDeliveryFailure(
  deps: Pick<BriefDeps, "config" | "deliver">,
  store: Store,
  kind: Exclude<DeliveryKind, "alert">,
  target: string,
  textFor: (status: Exclude<DeliveryStatus, "sent">) => string,
): Promise<void> {
  const streak = await store.deliveryStreakStart(kind, target);
  if (!streak || streak.status === "sent") return;
  const parents = (deps.config.demo ? DEMO_MEMBERS : deps.config.members).filter((member) => member.role === "parent");
  for (const parent of parents) {
    const key = `alert:${kind}:${target}:${streak.id}:${parent.profileId}`;
    if (await store.deliveryDone(key)) continue;
    const outcome = await deps.deliver({ member: parent.profileId }, [{ text: textFor(streak.status) }], key);
    await store.appendDeliveryLog(rowOf(key, "alert", parent.profileId, outcome));
  }
}

async function alertParents(deps: BriefDeps, store: Store, brief: DueBrief, target: string): Promise<void> {
  await alertDeliveryFailure(deps, store, brief.kind, target, (status) => alertText(brief, status));
}

/** One poll: each due brief whose key has no final row is built, sent once and logged. */
export async function briefTick(deps: BriefDeps, now: number): Promise<void> {
  const store = deps.store();
  const channel = deps.config.summaryChannel;
  if (!store || channel === undefined) return;
  for (const brief of dueBriefs(now, deps.config.timezone)) {
    if (await store.deliveryDone(brief.key)) continue;
    const message = await buildBrief(deps, brief, now);
    if (!message) {
      // Nothing is logged: the next tick in the window reads the calendar again.
      deps.log(`oc-family-pack: ${LABEL[brief.kind]} ${brief.key} waits: the calendar read failed`);
      continue;
    }
    const outcome = await deps.deliver({ channel }, [message], brief.key);
    const row = rowOf(brief.key, brief.kind, channel, outcome);
    await store.appendDeliveryLog(row);
    if (row.status !== "sent") {
      deps.log(`oc-family-pack: ${LABEL[brief.kind]} ${brief.key} logged ${row.status} (${row.errorKind})`);
      await alertParents(deps, store, brief, channel);
    }
  }
}

/** Polls every minute from now; ticks never overlap. Returns the stop function. */
export function startBriefs(deps: BriefDeps, now: () => number = Date.now): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await briefTick(deps, now());
    } catch (error) {
      deps.log(`oc-family-pack: brief tick failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The directory `deliver` reads ids from: roster members and configured channels. */
export function briefDirectory(config: Config): DeliveryDirectory {
  return { members: config.members, channels: config.channels ?? {} };
}

