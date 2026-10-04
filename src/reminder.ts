import type { DiscordEmbed, DiscordMessage } from "./discord-delivery.ts";
import type { DeliveryStatus } from "./store.ts";
import type { ReminderMode } from "./types.ts";
import { addDays, localDate, localTime } from "./week.ts";

export type { ReminderMode };

/** discord.Color.orange() (discord.py 2.7.1). */
export const REMINDER_COLOR = 0xe67e22;
/** One minute, the same poll the daily brief uses. A lead time inside the minute before or after a tick is due. */
export const REMINDER_TICK_MS = 60_000;
/** After quiet hours end, a reminder whose lead time fell inside them is still sent for this long. */
export const QUIET_FLUSH_MS = 60 * REMINDER_TICK_MS;

export type QuietHours = { startHour: number; endHour: number };

/** One timed event the reminder poll reads, owners already resolved in roster order. */
export type ReminderEvent = {
  /** Wire id of the first merged copy. Stable across a restart. */
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  /** Latest Google updated time across merged copies, or "" when none of them have one. */
  updated: string;
  owners: { profileId: string; displayName: string }[];
};

export type DueReminder = {
  key: string;
  event: ReminderEvent;
  leadMinutes: number;
  profileId: string;
  displayName: string;
  minsUntil: number;
};

/** Wall-clock hour in `timezone`, 0–23. A DST fall-back hour is the later one, as the clock shows it. */
export function wallHour(now: number, timezone: string): number {
  const raw = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(raw) % 24;
}

/** Bernie's quiet window (notification_router.py, default 22:00–07:00). Equal hours mean no quiet time. */
export function inQuietHours(now: number, timezone: string, quiet: QuietHours): boolean {
  if (quiet.startHour === quiet.endHour) return false;
  const hour = wallHour(now, timezone);
  if (quiet.startHour > quiet.endHour) return hour >= quiet.startHour || hour < quiet.endHour;
  return hour >= quiet.startHour && hour < quiet.endHour;
}

/** The quiet window that most recently ended, or none while quiet hours still hold. */
function lastQuietSpan(now: number, timezone: string, quiet: QuietHours): { start: number; end: number } | undefined {
  if (quiet.startHour === quiet.endHour || inQuietHours(now, timezone, quiet)) return undefined;
  const today = localDate(now, timezone);
  const todayEnd = localTime(today, quiet.endHour, timezone);
  const end = todayEnd <= now ? todayEnd : localTime(addDays(today, -1), quiet.endHour, timezone);
  const endDay = localDate(end, timezone);
  let start = localTime(endDay, quiet.startHour, timezone);
  if (start >= end) start = localTime(addDays(endDay, -1), quiet.startHour, timezone);
  return { start, end };
}

/** eventId, lead minutes, and the event's updated time, plus the owner, so each person is sent once. */
export function reminderKey(eventId: string, leadMinutes: number, updated: string, profileId: string): string {
  return `reminder:${eventId}:${leadMinutes}:${updated}:${profileId}`;
}

/**
 * Reminders to send at `now`. Quiet hours hold a normal reminder. For an hour after they end,
 * anything whose lead time fell inside that window is sent once. A lead within a minute of `now`
 * is sent outside quiet hours.
 */
export function dueReminders(events: readonly ReminderEvent[], now: number, timezone: string, leads: readonly number[], quiet: QuietHours): DueReminder[] {
  const quietNow = inQuietHours(now, timezone, quiet);
  const flush = lastQuietSpan(now, timezone, quiet);
  const flushing = flush !== undefined && now < flush.end + QUIET_FLUSH_MS;
  const due: DueReminder[] = [];
  for (const event of events) {
    const startMs = Date.parse(event.start);
    if (!Number.isFinite(startMs)) continue;
    for (const leadMinutes of leads) {
      const leadAt = startMs - leadMinutes * 60_000;
      const inPoll = now - REMINDER_TICK_MS < leadAt && leadAt <= now + REMINDER_TICK_MS;
      const inFlush = flushing && flush !== undefined && flush.start <= leadAt && leadAt < flush.end;
      if (quietNow || (!inPoll && !inFlush)) continue;
      const minsUntil = Math.round((startMs - now) / 60_000);
      for (const owner of event.owners) {
        due.push({
          key: reminderKey(event.id, leadMinutes, event.updated, owner.profileId),
          event,
          leadMinutes,
          profileId: owner.profileId,
          displayName: owner.displayName,
          minsUntil,
        });
      }
    }
  }
  return due;
}

const space = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

function clock(iso: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(Date.parse(iso)).map((part) => [part.type, part.value]),
  );
  return space(`${parts.hour}:${parts.minute} ${parts.dayPeriod}`);
}

function zoneShort(iso: string, timezone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(Date.parse(iso)).find((part) => part.type === "timeZoneName");
  return name?.value ?? timezone;
}

/** build_reminder_embed (ui/embeds.py:30-51), without a reaction footer: this path cannot add reactions. */
export function reminderEmbed(event: ReminderEvent, minsUntil: number, timezone: string, who: readonly string[]): DiscordEmbed {
  const title = [...event.title].slice(0, 256).join("");
  const description = minsUntil <= 1 ? "⏰ **Starting NOW!**" : minsUntil < 0 ? "⏰ **Already started**" : `⏰ Starting in **${minsUntil} minutes**`;
  const fields: NonNullable<DiscordEmbed["fields"]> = [
    { name: "🕐 Time", value: `${clock(event.start, timezone)} – ${clock(event.end, timezone)} ${zoneShort(event.start, timezone)}`.slice(0, 1024), inline: true },
  ];
  if (event.location) fields.push({ name: "📍 Location", value: [...event.location].slice(0, 1024).join(""), inline: true });
  if (who.length > 0) fields.push({ name: "👨‍👩‍👧 Who", value: who.join(", ").slice(0, 1024), inline: false });
  return { title: `📅 ${title}`, description, color: REMINDER_COLOR, fields };
}

/** A direct message is the embed. A channel post names the person in front of it. */
export function reminderMessage(event: ReminderEvent, minsUntil: number, timezone: string, who: readonly string[], mention?: string): DiscordMessage {
  const embed = reminderEmbed(event, minsUntil, timezone, who);
  return mention === undefined ? { embed } : { text: `${mention} — heads up!`, embed };
}

const LABEL: Record<Exclude<DeliveryStatus, "sent">, (title: string) => string> = {
  failed: (title) => `A reminder for ${title} was not posted: Family has no Discord id for it in config.`,
  held: (title) => `A reminder for ${title} has not gone out yet: Discord could not be reached. It may still go out later.`,
  partial: (title) => `A reminder for ${title} was only partly posted.`,
  unknown: (title) => `A reminder for ${title} may not have been posted. Check Discord.`,
};

/** One line for the parent alert. The title is collapsed and capped; it never includes an id. */
export function reminderAlert(title: string, status: Exclude<DeliveryStatus, "sent">): string {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 80) || "an event";
  return LABEL[status](clean);
}
