import type { FamilyEvent } from "./types.ts";

/** Copies of one event start within this window of the earliest copy. */
const MERGE_WINDOW_MS = 15 * 60_000;

const normalTitle = (title: string) => title.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

const byStartThenCalendarThenId = (a: FamilyEvent, b: FamilyEvent) =>
  Date.parse(a.start) - Date.parse(b.start) || a.calendarKey.localeCompare(b.calendarKey) || a.id.localeCompare(b.id);

/**
 * The same event read from several calendars becomes one event. Copies match
 * when their normalized titles are equal, both are all-day or both timed, and
 * each starts within 15 minutes of the earliest copy, so copies never chain.
 * The earliest copy supplies id, title, times and `calendarKey`; `calendarKeys`
 * lists every source calendar and is set only when there are two or more.
 * Events keep their input order; a merged event sits where its earliest copy was.
 */
export function mergeCopies(events: readonly FamilyEvent[]): FamilyEvent[] {
  const groups: FamilyEvent[][] = [];
  const open = new Map<string, FamilyEvent[]>();
  const order = new Map(events.map((event, index) => [event, index]));
  for (const event of [...events].sort(byStartThenCalendarThenId)) {
    const key = `${event.allDay ? "day" : "time"}:${normalTitle(event.title)}`;
    const group = open.get(key);
    const first = group?.[0];
    if (group && first && Date.parse(event.start) - Date.parse(first.start) <= MERGE_WINDOW_MS) {
      group.push(event);
      continue;
    }
    const fresh = [event];
    groups.push(fresh);
    open.set(key, fresh);
  }
  groups.sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);
  return groups.map(([first, ...rest]) => {
    const merged: FamilyEvent = { ...first! };
    if (rest.length === 0) {
      return merged;
    }
    const copies = [first!, ...rest];
    const location = copies.find((copy) => copy.location !== undefined)?.location;
    const htmlLink = copies.find((copy) => copy.htmlLink !== undefined)?.htmlLink;
    if (location !== undefined) merged.location = location;
    if (htmlLink !== undefined) merged.htmlLink = htmlLink;
    const calendarKeys = [...new Set(copies.map((copy) => copy.calendarKey))];
    if (calendarKeys.length > 1) merged.calendarKeys = calendarKeys;
    return merged;
  });
}
