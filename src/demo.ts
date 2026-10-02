import type { CalendarConfig, FamilyEvent, MemberConfig } from "./types.ts";
import { addDays, localTime, type Week } from "./week.ts";

export const DEMO_MEMBERS: MemberConfig[] = [
  { profileId: "alex", displayName: "Alex", role: "parent", devices: [] },
  { profileId: "sam", displayName: "Sam", role: "parent", devices: [] },
  { profileId: "riley", displayName: "Riley", role: "kid", devices: [] },
  { profileId: "jordan", displayName: "Jordan", role: "kid", devices: [] },
];

const CALENDARS = {
  alex: { key: "c0", id: "demo-alex", label: "Alex", kind: "personal", owners: ["alex"] },
  sam: { key: "c1", id: "demo-sam", label: "Sam", kind: "personal", owners: ["sam"] },
  riley: { key: "c2", id: "demo-riley", label: "Riley", kind: "personal", owners: ["riley"] },
  jordan: { key: "c3", id: "demo-jordan", label: "Jordan", kind: "personal", owners: ["jordan"] },
  family: { key: "c4", id: "demo-family", label: "Family", kind: "shared", owners: ["alex", "sam", "riley", "jordan"] },
  school: { key: "c5", id: "demo-school", label: "School", kind: "school", owners: ["riley", "jordan"] },
} satisfies Record<string, CalendarConfig>;

export const DEMO_CALENDARS: CalendarConfig[] = Object.values(CALENDARS);

type CalendarKey = keyof typeof CALENDARS;
type Timed = [day: number, from: number, to: number, title: string, calendar: CalendarKey, location?: string];
type AllDay = [firstDay: number, days: number, title: string, calendar: CalendarKey];

const TIMED: Timed[] = [
  [0, 8.25, 8.75, "School drop-off", "family"],
  [0, 18, 19, "Swim practice", "riley", "Community Pool"],
  [1, 9.5, 10.5, "Dentist", "alex", "Bank Street Dental"],
  [1, 16.5, 17.5, "Piano lesson", "jordan", "Music Studio"],
  [2, 12, 13, "Team lunch", "sam"],
  [2, 19, 20.5, "Parent-teacher night", "family", "Elementary School"],
  [3, 17, 18.5, "Soccer", "riley", "Riverside Park"],
  [3, 18.5, 19.5, "Book club", "sam", "Main Library"],
  [4, 19, 21, "Movie night", "family"],
  [5, 9, 10, "Farmers market", "family", "Market Square"],
  [5, 13, 15, "Birthday party", "jordan"],
  [5, 19, 34, "Sleepover", "riley"],
  [6, 11, 12, "Grocery run", "alex"],
];

const ALL_DAY: AllDay[] = [
  [2, 1, "Pizza lunch", "school"],
  [4, 1, "PD day, no school", "school"],
  [4, 3, "Grandparents visiting", "family"],
];

export function demoEvents(week: Week): FamilyEvent[] {
  const { start, timezone } = week.range;
  const at = (day: number, hours: number) => new Date(localTime(addDays(start, day), hours, timezone)).toISOString();
  const timed = TIMED.map(([day, from, to, title, calendar, location], index): FamilyEvent => ({
    id: `demo/t${index}`,
    title,
    start: at(day, from),
    end: at(day, to),
    allDay: false,
    ...(location ? { location } : {}),
    calendarKey: CALENDARS[calendar].key,
  }));
  const allDay = ALL_DAY.map(([day, days, title, calendar], index): FamilyEvent => ({
    id: `demo/a${index}`,
    title,
    start: addDays(start, day),
    end: addDays(start, day + days),
    allDay: true,
    calendarKey: CALENDARS[calendar].key,
  }));
  return [...allDay, ...timed];
}
