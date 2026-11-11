import type { Static } from "typebox";
import type {
  CalendarChangedSchema,
  CalendarRefSchema,
  CalendarWriteSchema,
  FamilyEventSchema,
  GarbageOutputSchema,
  MembersPayloadSchema,
  RosterMemberSchema,
  ScheduleInputSchema,
  ScheduleOutputSchema,
  TodayPayloadSchema,
  WeatherCardSchema,
  WeatherRecommendationSchema,
  WeatherStateSchema,
  WeekPayloadSchema,
} from "./contract.ts";

export type MemberRole = "parent" | "kid" | "guest";
/** Where a person's event reminders go. `channel` mentions them in the brief channel. */
export type ReminderMode = "dm" | "channel" | "off";
export type CalendarKind = "personal" | "shared" | "school";
/** The operator's switch for calendar changes: on, every change waits for approval, or none at all. */
export type WriteMode = "on" | "confirm" | "off";

/**
 * A configured address reservation. This is what the operator wrote down.
 * It is not an observed address, and storing it does not change a router.
 */
export type DeviceReservation = {
  address: string;
  network?: string;
  source: string;
};

/**
 * A device record. MACs are already lowercase and colon-separated.
 * They are not a person identity and they grant nothing.
 * `id` stays put once it is written. `sharedWith` names other member ids on this one record.
 */
export type MemberDevice = {
  id: string;
  label: string;
  hostname?: string;
  primaryMac: string;
  aliasMacs: string[];
  source: string;
  reservation?: DeviceReservation;
  sharedWith: string[];
};

export type MemberConfig = {
  /**
   * The household person id. Owners, briefs, delivery, and Today use it.
   * An omitted id still loads as the login, else a slug of the name, so old
   * config keeps the same owners. Once `id` is written, a name or login change
   * does not change it.
   */
  id: string;
  /**
   * The Control UI login: the trusted-proxy username. Optional, never derived,
   * and not the Gateway's internal profile id. `login` in config is the same field.
   */
  profileId?: string;
  /**
   * The Gateway profile id from the host-attested client profile, when the
   * operator has linked one. It is not inferred, and it is not the login.
   */
  gatewayProfileId?: string;
  displayName: string;
  /**
   * Names the family actually uses for this person: "Mom", "Dad", a first name,
   * or a nickname. Addressing only; aliases never authorize a Discord sender or
   * a page viewer.
   */
  aliases?: string[];
  /** Groups this person belongs to, such as a grade. Matching only; never a name. */
  cohorts?: string[];
  lobsterPreferences?: string[];
  /** Stored on the card only. Nothing in the plugin sends email or shows it on the week. */
  email?: string;
  /** Stored on the card only. Nothing in the plugin sends SMS. */
  phone?: string;
  color?: string;
  role: MemberRole;
  /** Discord sender id. Stays in config; never copied onto the week payload. This version delivers through it. */
  discordId?: string;
  /** How this person gets event reminders. Omitted means a direct message. A chat change overrides it. */
  reminders?: ReminderMode;
  /** Normalized at parse. Stays in config; never copied onto the week payload. */
  devices: MemberDevice[];
};

/**
 * A household rule for one school title. The first match wins, and the result
 * is only people who already own that calendar.
 */
export type AudienceRule = {
  title: string;
  audience: "school" | "cohort" | "student";
  cohort?: string;
  students?: string[];
  calendar?: string;
};

/** A stored choice for one provider event. It does not copy the event or invite anyone. */
export type ParticipantOverride = {
  calendarKey: string;
  eventId: string;
  memberId: string;
  decision: "confirm" | "reject";
};

export type CalendarConfig = {
  /** The calendar's stable wire key; omitted config falls back to its array position. */
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
  /** The city's collection calendar (ICS). Stays in config; never in a tool reply. */
  garbageIcsUrl?: string;
  /** Discord channel ids by key. Delivery targets and rows name the key, never the id. */
  channels?: Record<string, string>;
  /** Optional Discord account id from channels.discord.accounts; the host default when omitted. */
  discordAccount?: string;
  /** `lan` treats a paired device token as a guest; `solo` keeps the shared-owner model. */
  accessMode?: "solo" | "lan";
  /** The channels key the daily and weekly briefs post to; briefs are off without it. Channel reminders use it too. */
  summaryChannel?: string;
  /** Minutes before an event to remind its owners. Empty sends nothing. Omitted means 15. */
  reminderLeadMinutes?: number[];
  /** Hours when reminders wait, in the household zone. Omitted means 22:00–07:00. */
  quietHours?: { startHour: number; endHour: number };
  /** Weekday morning parent DMs, HH:MM. Omitted means the job is off. */
  morningTime?: string;
  /** Weekday after-school channel post, HH:MM. Omitted means the job is off. */
  afterSchoolTime?: string;
  /** Weekend preview channel post, HH:MM. Omitted means the job is off. */
  weekendPreviewTime?: string;
  /** Weekday of the preview, 0 Sunday through 6 Saturday. Omitted means Friday. */
  weekendPreviewWeekday?: number;
  /** Phrases that mark a school-logistics event. Empty sends those events with everything else. */
  schoolHints?: string[];
  /** Phrases that mark a weekday closed, so the after-school post stays quiet. Empty means only weekends. */
  closedDayPhrases?: string[];
  gogPath: string;
  writes: WriteMode;
  members: MemberConfig[];
  calendars: CalendarConfig[];
  /** Manual confirm or reject for a named participant. Title matches still apply to every other event. */
  participantOverrides?: ParticipantOverride[];
  /** School-title audiences. The first matching rule wins. Absent rules leave calendar owners as they are. */
  audienceRules?: AudienceRule[];
};

export type SourceState<T> =
  | { status: "ok"; data: T }
  | { status: "unconfigured"; hint: string }
  | { status: "error"; message: string };

export type FamilyEvent = Static<typeof FamilyEventSchema>;
export type CalendarRef = Static<typeof CalendarRefSchema>;
export type WeatherCard = Static<typeof WeatherCardSchema>;
export type WeatherRecommendation = Static<typeof WeatherRecommendationSchema>;
export type WeatherState = Static<typeof WeatherStateSchema>;
export type WeekPayload = Static<typeof WeekPayloadSchema>;
export type MembersPayload = Static<typeof MembersPayloadSchema>;
export type RosterMember = Static<typeof RosterMemberSchema>;
export type CalendarWrite = Static<typeof CalendarWriteSchema>;
export type TodayPayload = Static<typeof TodayPayloadSchema>;
export type CalendarChanged = Static<typeof CalendarChangedSchema>;
export type ScheduleInput = Static<typeof ScheduleInputSchema>;
export type ScheduleOutput = Static<typeof ScheduleOutputSchema>;
export type GarbageOutput = Static<typeof GarbageOutputSchema>;
export type CalendarState = WeekPayload["calendar"];
/** A calendar read whose events carry more than the wire fields, such as gog's Google fields. */
export type CalendarStateOf<E extends FamilyEvent> = Exclude<CalendarState, { status: "ok" }> | { status: "ok"; data: E[]; warnings: string[] };
export type Member = WeekPayload["members"][number];
export type WeekDay = WeekPayload["days"][number];
export type WeekRange = WeekPayload["range"];
