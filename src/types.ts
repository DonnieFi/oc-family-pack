import type { Static } from "typebox";
import type { CalendarRefSchema, FamilyEventSchema, WeatherCardSchema, WeekPayloadSchema } from "./contract.ts";

export type MemberRole = "parent" | "kid" | "guest";
export type CalendarKind = "personal" | "shared" | "school";

export type MemberConfig = {
  profileId: string;
  displayName: string;
  color?: string;
  role: MemberRole;
};

export type CalendarConfig = {
  /** The calendar's wire key, assigned from its position in the config. */
  key: string;
  id: string;
  label: string;
  kind: CalendarKind;
  owners: string[];
};

export type Location = { lat: number; lon: number; label?: string };

export type Config = {
  timezone: string;
  demo: boolean;
  location?: Location;
  gogPath: string;
  members: MemberConfig[];
  calendars: CalendarConfig[];
};

export type SourceState<T> =
  | { status: "ok"; data: T }
  | { status: "unconfigured"; hint: string }
  | { status: "error"; message: string };

export type FamilyEvent = Static<typeof FamilyEventSchema>;
export type CalendarRef = Static<typeof CalendarRefSchema>;
export type WeatherCard = Static<typeof WeatherCardSchema>;
export type WeekPayload = Static<typeof WeekPayloadSchema>;
export type CalendarState = WeekPayload["calendar"];
export type Member = WeekPayload["members"][number];
export type WeekDay = WeekPayload["days"][number];
export type WeekRange = WeekPayload["range"];
