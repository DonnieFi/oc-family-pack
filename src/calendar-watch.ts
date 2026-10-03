import type { FeatureEventEmitter } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import type { contract } from "./contract.ts";
import type { CalendarConfig, Config } from "./types.ts";

export const POLL_MS = 3 * 60_000;
export const MAX_WAIT_MS = 30 * 60_000;
/** gog's own default window for `calendar changed`, used until a calendar has a baseline. */
const FIRST_SINCE = "720h";

/** Runs `run` after `ms`; the returned function cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

/** The live timer never keeps the Gateway process alive on its own. */
export const unrefSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

type Read = { ok: true; mark: string } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The calendar's newest `updated`, or gog's `since` when nothing changed in the
 * window. Both are Google-clock times, so deba's clock never enters a comparison.
 */
function markOf(raw: unknown): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return undefined;
  let newest: number | undefined;
  for (const item of raw.events) {
    const at = isRecord(item) && typeof item.updated === "string" ? Date.parse(item.updated) : Number.NaN;
    if (Number.isFinite(at) && (newest === undefined || at > newest)) newest = at;
  }
  if (newest !== undefined) return new Date(newest).toISOString();
  return typeof raw.since === "string" && Number.isFinite(Date.parse(raw.since)) ? raw.since : undefined;
}

/**
 * One calendar per call: with `--cal` or `--all`, gog writes a failed calendar
 * to stderr and still exits 0, so a failure would look like a quiet calendar.
 */
async function readCalendar(config: Config, calendar: CalendarConfig, since: string, runGog: RunGog): Promise<Read> {
  try {
    const { stdout } = await runGog(config.gogPath, ["calendar", "changed", "--since", since, "--max", "1", "--json", "--no-input", "--", calendar.id]);
    const mark = markOf(JSON.parse(stdout));
    return mark === undefined ? { ok: false } : { ok: true, mark };
  } catch {
    return { ok: false };
  }
}

/**
 * Polls `gog calendar changed` per roster calendar and tells open pages when
 * Google changed underneath them. State is in memory: a restart takes a fresh
 * baseline, and a calendar's first successful read never counts as a change.
 * gog drops the milliseconds from `--since`, so the newest event comes back on
 * every poll; only a strictly newer `updated` is a change.
 */
export function watchCalendars(options: {
  config: Config;
  runGog: RunGog;
  events: FeatureEventEmitter<typeof contract>;
  logger: { warn: (message: string) => void };
  schedule?: Schedule;
}): () => void {
  const { config, runGog, events, logger, schedule = unrefSchedule } = options;
  if (config.demo || config.calendars.length === 0) return () => {};
  const marks = new Map<string, string>();
  let stopped = false;
  let cancel = () => {};
  let wait = POLL_MS;

  const send = (emit: () => void, name: string) => {
    try {
      emit();
    } catch (error) {
      logger.warn(`oc-family-pack: ${name} was not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const poll = async (first: boolean) => {
    const reads = await Promise.all(
      config.calendars.map(async (calendar) => [calendar, await readCalendar(config, calendar, marks.get(calendar.key) ?? FIRST_SINCE, runGog)] as const),
    );
    if (stopped) return;
    let changed = false;
    let ok = true;
    for (const [calendar, read] of reads) {
      if (!read.ok) {
        ok = false;
        logger.warn(`oc-family-pack: could not check the "${calendar.label}" calendar for changes`);
        continue;
      }
      const before = marks.get(calendar.key);
      if (before === undefined || Date.parse(read.mark) > Date.parse(before)) {
        marks.set(calendar.key, read.mark);
        if (before !== undefined) changed = true;
      }
    }
    if (!first) {
      if (changed) send(() => events.emit("calendar-changed", { reason: "external", calendarKeys: [], at: new Date().toISOString() }), "calendar-changed");
      if (ok) send(() => events.emit("calendar-checked", {}), "calendar-checked");
    }
    wait = ok ? POLL_MS : Math.min(wait * 2, MAX_WAIT_MS);
    cancel = schedule(() => void poll(false), wait);
  };

  // Not awaited: sixteen calendars and gog's timeout must never hold up the Gateway's start.
  void poll(true);
  return () => {
    stopped = true;
    cancel();
  };
}
