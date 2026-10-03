import type { Static } from "typebox";
import type {
  CalendarChangedSchema,
  CalendarRefSchema,
  CalendarWriteSchema,
  FamilyEventSchema,
  MembersPayloadSchema,
  ScheduleInputSchema,
  ScheduleOutputSchema,
  TodayPayloadSchema,
  WeatherCardSchema,
  WeatherStateSchema,
  WeekPayloadSchema,
} from "./contract.ts";

export type MemberRole = "parent" | "kid" | "guest";
export type CalendarKind = "personal" | "shared" | "school";

/** A device signal. MACs are already lowercase and colon-separated; they are not a person identity. */
export type MemberDevice = {
  label: string;
  primaryMac: string;
  aliasMacs: string[];
  source: string;
};

export type MemberConfig = {
  profileId: string;
  displayName: string;
  color?: string;
  role: MemberRole;
  /** Discord sender id. Stays in config; never copied onto the week payload. */
  discordId?: string;
  /** Normalized at parse. Stays in config; never copied onto the week payload. */
  devices: MemberDevice[];
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
export type WeatherState = Static<typeof WeatherStateSchema>;
export type WeekPayload = Static<typeof WeekPayloadSchema>;
export type MembersPayload = Static<typeof MembersPayloadSchema>;
export type CalendarWrite = Static<typeof CalendarWriteSchema>;
export type TodayPayload = Static<typeof TodayPayloadSchema>;
export type CalendarChanged = Static<typeof CalendarChangedSchema>;
export type ScheduleInput = Static<typeof ScheduleInputSchema>;
export type ScheduleOutput = Static<typeof ScheduleOutputSchema>;
export type CalendarState = WeekPayload["calendar"];
/** A calendar read whose events carry more than the wire fields, such as gog's Google fields. */
export type CalendarStateOf<E extends FamilyEvent> = Exclude<CalendarState, { status: "ok" }> | { status: "ok"; data: E[]; warnings: string[] };
export type Member = WeekPayload["members"][number];
export type WeekDay = WeekPayload["days"][number];
export type WeekRange = WeekPayload["range"];
