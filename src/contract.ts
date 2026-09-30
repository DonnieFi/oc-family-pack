import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type, type TSchema } from "typebox";

export const MAX_MEMBERS = 32;
export const MAX_CALENDARS = 16;
/**
 * Feature results are capped at 4096 JSON nodes, counting every value. With every list at its
 * maximum, the fixed part costs 845 nodes: root 1, mode 1, range 4, today 1, days 29 (7 x 4 + 1),
 * members 161 (32 x 5 + 1), calendars 593 (16 x (5 + 32 owners) + 1), calendar state 20
 * (object, status, data, warnings, 16 warnings), weather 35 (with 8 forecast periods).
 * An event costs 9 nodes (object plus 8 fields) and up to 7 more as a day reference on every
 * day it spans, so (4096 - 845) / 16 = 203 events fit; 200 leaves a margin.
 */
export const MAX_WEEK_EVENTS = 200;

export const EVENT_ID_MAX = 1040;
export const TITLE_MAX = 500;
export const LOCATION_MAX = 500;
export const LINK_MAX = 2048;
export const LABEL_MAX = 200;
export const MESSAGE_MAX = 1000;

const IsoDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Text = (maxLength: number) => Type.String({ maxLength });
const CalendarKind = Type.Union([Type.Literal("personal"), Type.Literal("shared"), Type.Literal("school")]);
const MemberRole = Type.Union([Type.Literal("parent"), Type.Literal("kid"), Type.Literal("guest")]);

/** Keys are positional (`c0`, `c1`, ...) so Google calendar IDs never leave the Gateway. */
export const CalendarRefSchema = Type.Object({
  key: Text(8),
  label: Text(LABEL_MAX),
  kind: CalendarKind,
  ownerIds: Type.Array(Text(LABEL_MAX), { maxItems: MAX_MEMBERS }),
});

/** Timed events carry ISO instants; all-day events carry YYYY-MM-DD dates with an exclusive end. */
export const FamilyEventSchema = Type.Object({
  id: Text(EVENT_ID_MAX),
  title: Text(TITLE_MAX),
  start: Text(32),
  end: Text(32),
  allDay: Type.Boolean(),
  location: Type.Optional(Text(LOCATION_MAX)),
  calendarKey: Text(8),
  htmlLink: Type.Optional(Text(LINK_MAX)),
});

export const WeatherCardSchema = Type.Object({
  stationName: Text(200),
  observedAt: Type.Optional(Text(32)),
  tempC: Type.Optional(Type.Number()),
  condition: Type.Optional(Text(200)),
  highC: Type.Optional(Type.Number()),
  lowC: Type.Optional(Type.Number()),
  forecast: Type.Array(Type.Object({ period: Text(100), summary: Text(500) }), { maxItems: 8 }),
  sourceUrl: Text(2048),
});

const Unconfigured = Type.Object({ status: Type.Literal("unconfigured"), hint: Text(MESSAGE_MAX) });
const Failed = Type.Object({ status: Type.Literal("error"), message: Text(MESSAGE_MAX) });

const sourceState = <T extends TSchema>(data: T) =>
  Type.Union([Type.Object({ status: Type.Literal("ok"), data }), Unconfigured, Failed]);

export const WeekPayloadSchema = Type.Object({
  mode: Type.Union([Type.Literal("demo"), Type.Literal("live")]),
  /** Local dates in `timezone`; `end` is the last day of the week, inclusive. */
  range: Type.Object({ start: IsoDate, end: IsoDate, timezone: Text(64) }),
  today: IsoDate,
  days: Type.Array(
    Type.Object({ date: IsoDate, isToday: Type.Boolean(), eventIds: Type.Array(Text(EVENT_ID_MAX), { maxItems: MAX_WEEK_EVENTS }) }),
    { minItems: 7, maxItems: 7 },
  ),
  members: Type.Array(
    Type.Object({ profileId: Text(LABEL_MAX), displayName: Text(LABEL_MAX), color: Text(100), role: MemberRole }),
    { maxItems: MAX_MEMBERS },
  ),
  calendars: Type.Array(CalendarRefSchema, { maxItems: MAX_CALENDARS }),
  /** `warnings` names calendars that failed to load while the rest still show. */
  calendar: Type.Union([
    Type.Object({
      status: Type.Literal("ok"),
      data: Type.Array(FamilyEventSchema, { maxItems: MAX_WEEK_EVENTS }),
      warnings: Type.Array(Text(MESSAGE_MAX), { maxItems: MAX_CALENDARS }),
    }),
    Unconfigured,
    Failed,
  ]),
  weather: sourceState(WeatherCardSchema),
});

export const contract = defineFeatureContract({
  pluginId: "oc-family-pack",
  operations: {
    "family.week": {
      kind: "query",
      description:
        "Read one Monday-to-Sunday family week: calendar events grouped by local day, the calendars and member roster with colors, and local weather.",
      input: Type.Object({ start: Type.Optional(IsoDate) }, { additionalProperties: false }),
      output: WeekPayloadSchema,
    },
  },
  events: {},
});
