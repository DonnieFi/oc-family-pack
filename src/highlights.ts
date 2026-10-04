import { clockTime } from "./classify.ts";

/** What `buildHighlightLines` scores. School classes are owned by the one 🏫 line, not the imminent lines. */
export type HighlightEvent = {
  summary: string;
  /** Epoch milliseconds. Ignored for an all-day event. */
  startMs: number;
  endMs: number;
  allDay: boolean;
  school: boolean;
};

export const QUIET_DAY = "Looks like a quiet day — nothing urgent.";
export const GARBAGE_TOMORROW = "🗑️ Garbage tomorrow — put bins out tonight";

const HOUR_MS = 3_600_000;
const SOON_MIN = 120;
const LATER_MIN = 240;

type Candidate = { line: string; body: string; urgency: number };

/** "9:30 AM" from `clockTime`, padded to "09:30 AM" the way `%I:%M %p` is. */
function paddedClock(iso: string, timezone: string): string {
  return clockTime(iso, timezone).replace(/^(\d):/, "0$1:");
}

/**
 * The three most urgent calendar lines, highest urgency first.
 * Garbage tomorrow is urgency 4, only when the caller already knows tomorrow has a pickup.
 * A timed event that is not school: under two hours is urgency 5, under four hours is urgency 3.
 * The first school class that ended less than an hour ago, or has not ended, is urgency 3.
 * Same text is kept once. Nothing urgent is the one quiet line.
 */
export function buildHighlightLines(events: readonly HighlightEvent[], now: number, timezone: string, garbageTomorrow: boolean): string[] {
  const candidates: Candidate[] = [];
  if (garbageTomorrow) candidates.push({ line: GARBAGE_TOMORROW, body: "Garbage tomorrow — put bins out tonight", urgency: 4 });

  const timed = events
    .filter((event) => !event.allDay && Number.isFinite(event.startMs) && Number.isFinite(event.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));

  for (const event of timed) {
    if (event.school) continue;
    const minutes = (event.startMs - now) / 60_000;
    if (minutes <= 0 || minutes >= LATER_MIN) continue;
    if (minutes < SOON_MIN) {
      const body = `${event.summary} in ${Math.trunc(minutes)} min`;
      candidates.push({ line: `⏰ ${body}`, body, urgency: 5 });
    } else {
      const body = `${event.summary} at ${paddedClock(new Date(event.startMs).toISOString(), timezone)}`;
      candidates.push({ line: `📅 ${body}`, body, urgency: 3 });
    }
  }

  const school = timed.find((event) => event.school && event.endMs - now > -HOUR_MS);
  if (school) {
    const body = `${school.summary} · ${clockTime(new Date(school.startMs).toISOString(), timezone)}`;
    candidates.push({ line: `🏫 ${body}`, body, urgency: 3 });
  }

  candidates.sort((a, b) => b.urgency - a.urgency);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.body)) continue;
    seen.add(candidate.body);
    lines.push(candidate.line);
    if (lines.length === 3) break;
  }
  return lines.length > 0 ? lines : [QUIET_DAY];
}
