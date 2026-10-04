import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type } from "typebox";
export const MAX_MEMBERS = 32;
export const MAX_CALENDARS = 16;
/**
 * Feature results are capped at 4096 JSON nodes, counting every value. With every list at its
 * maximum, the fixed part costs 847 nodes: root 1, mode 1, range 4, today 1, days 29 (7 x 4 + 1),
 * members 161 (32 x 5 + 1), calendars 593 (16 x (5 + 32 owners) + 1), calendar state 20
 * (object, status, data, warnings, 16 warnings), weather 35 (with 8 forecast periods), and the
 * two write flags.
 * A single-source event costs 9 nodes (object plus 8 fields) and up to 7 more as a day reference
 * on every day it spans, so (4096 - 847) / 16 = 203 such events fit; 200 leaves a margin.
 * A merged event adds calendarKeys, 3 to 17 more nodes (the array plus 2 to 16 keys), so a week
 * heavy with merges can pass 4096 under this cap. fitWeek checks the real payload against the
 * host's limits and sends a calendar error instead of a week the host would reject.
 */
export const MAX_WEEK_EVENTS = 200;
export const EVENT_ID_MAX = 1040;
export const TITLE_MAX = 500;
export const LOCATION_MAX = 500;
export const LINK_MAX = 2048;
export const LABEL_MAX = 200;
export const MESSAGE_MAX = 1000;
/** Google event description limit, kept under the 8 KiB API cap. */
export const DESCRIPTION_MAX = 8000;
/** Bernie's idempotency key limit (email_service.py:603-610), for a page write's requestId. */
export const REQUEST_ID_MAX = 256;
/** family.today keeps the three most urgent lines. */
export const MAX_HIGHLIGHTS = 3;
/**
 * Feature event ids. Dots are rejected, so the calendar event is `calendar-changed`.
 * Later beads register it; this module only exports the id and the payload schema.
 */
export const FEATURE_EVENT_ID_PATTERN = "^[a-z][a-z0-9_-]{0,127}$";
export const CALENDAR_CHANGED_EVENT = "calendar-changed";
export const CALENDAR_CHECKED_EVENT = "calendar-checked";
const ISO_DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const IsoDate = Type.String({ pattern: ISO_DATE });
const Text = (maxLength) => Type.String({ maxLength });
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
    /** Every visible calendar a merged event was read from, earliest first; absent for a single source. */
    calendarKeys: Type.Optional(Type.Array(Text(8), { minItems: 2, maxItems: MAX_CALENDARS })),
    htmlLink: Type.Optional(Text(LINK_MAX)),
});
/** Bernie's weather cache (weather_cache_ttl_s, 1800 s): one Environment Canada read is reused for 30 minutes. Not configurable. */
export const WEATHER_CACHE_MINUTES = 30;
/** Bernie's recommendation_engine output for the card: one summary line, what to bring, at most one alert. */
export const WeatherRecommendationSchema = Type.Object({
    summary: Text(500),
    clothing: Type.Array(Text(100), { maxItems: 8 }),
    alerts: Type.Array(Text(200), { maxItems: 1 }),
    severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});
export const WeatherCardSchema = Type.Object({
    stationName: Text(200),
    observedAt: Type.Optional(Text(32)),
    tempC: Type.Optional(Type.Number()),
    windKmh: Type.Optional(Type.Number()),
    recommendation: Type.Optional(WeatherRecommendationSchema),
    condition: Type.Optional(Text(200)),
    highC: Type.Optional(Type.Number()),
    lowC: Type.Optional(Type.Number()),
    forecast: Type.Array(Type.Object({ period: Text(100), summary: Text(500) }), { maxItems: 8 }),
    sourceUrl: Text(2048),
});
const Unconfigured = Type.Object({ status: Type.Literal("unconfigured"), hint: Text(MESSAGE_MAX) });
const Failed = Type.Object({ status: Type.Literal("error"), message: Text(MESSAGE_MAX) });
const sourceState = (data) => Type.Union([Type.Object({ status: Type.Literal("ok"), data }), Unconfigured, Failed]);
const NonEmpty = (maxLength) => Type.String({ minLength: 1, maxLength });
const RecurrenceScope = Type.Union([Type.Literal("single"), Type.Literal("future"), Type.Literal("all")]);
const EmptyInput = Type.Object({}, { additionalProperties: false });
/**
 * What a picker shows for one person. discordId and device MACs stay in config:
 * a chip needs the id it submits, the name and color it paints, and the role
 * (so a guest can be labeled). Nothing else.
 */
export const MemberSchema = Type.Object({
    profileId: Text(LABEL_MAX),
    displayName: Text(LABEL_MAX),
    color: Text(100),
    role: MemberRole,
}, { additionalProperties: false });
export const WeatherStateSchema = sourceState(WeatherCardSchema);
export const MembersPayloadSchema = Type.Object({ members: Type.Array(MemberSchema, { maxItems: MAX_MEMBERS }) }, { additionalProperties: false });
const eventDetails = {
    allDay: Type.Optional(Type.Boolean()),
    location: Type.Optional(Text(LOCATION_MAX)),
    description: Type.Optional(Text(DESCRIPTION_MAX)),
};
/** One per submit, so two submits are two requests. calendar-write's checkKey runs on it too. */
const RequestId = Type.String({ minLength: 1, maxLength: REQUEST_ID_MAX, pattern: "^[^\\r\\n]+$" });
/**
 * One calendar write from the page, discriminated by `op`. Calendars are wire keys (`c0`), and
 * `id` is the wire event id (`c0/...`), so Google calendar ids never appear here. A repeating
 * event's occurrence id already names its original start.
 */
export const CalendarWriteSchema = Type.Union([
    Type.Object({
        op: Type.Literal("create"),
        requestId: RequestId,
        calendarKey: NonEmpty(8),
        title: NonEmpty(TITLE_MAX),
        start: NonEmpty(32),
        end: NonEmpty(32),
        ...eventDetails,
    }, { additionalProperties: false }),
    Type.Object({
        op: Type.Literal("update"),
        requestId: RequestId,
        id: NonEmpty(EVENT_ID_MAX),
        scope: Type.Optional(RecurrenceScope),
        title: Type.Optional(NonEmpty(TITLE_MAX)),
        start: Type.Optional(NonEmpty(32)),
        end: Type.Optional(NonEmpty(32)),
        ...eventDetails,
    }, { additionalProperties: false }),
    Type.Object({
        op: Type.Literal("move"),
        requestId: RequestId,
        id: NonEmpty(EVENT_ID_MAX),
        destinationKey: NonEmpty(8),
    }, { additionalProperties: false }),
    Type.Object({
        op: Type.Literal("delete"),
        requestId: RequestId,
        id: NonEmpty(EVENT_ID_MAX),
        scope: Type.Optional(RecurrenceScope),
    }, { additionalProperties: false }),
]);
/** A page write's answer: whether it happened, and ux's line. No event id, no key. */
export const CalendarWriteResultSchema = Type.Object({ ok: Type.Boolean(), message: Text(MESSAGE_MAX) }, { additionalProperties: false });
export const CALENDAR_WRITE_ACTION = "family.calendar.write";
/** The dashboard widget id. The Control UI registers this id, and the plugin advertises the same one. */
export const TODAY_WIDGET_ID = "family-today";
/** Highlights plus today's noteworthy events. `family.today` returns it. */
export const TodayPayloadSchema = Type.Object({
    date: IsoDate,
    highlights: Type.Array(Text(MESSAGE_MAX), { maxItems: MAX_HIGHLIGHTS }),
    exceptions: Type.Array(Type.Object({
        id: Text(EVENT_ID_MAX),
        title: Text(TITLE_MAX),
        start: Text(32),
        end: Text(32),
        allDay: Type.Boolean(),
        location: Type.Optional(Text(LOCATION_MAX)),
        calendarKey: Text(8),
        ownerIds: Type.Array(Text(LABEL_MAX), { maxItems: MAX_MEMBERS }),
    }, { additionalProperties: false }), { maxItems: MAX_WEEK_EVENTS }),
}, { additionalProperties: false });
/** Payload for `calendar-changed`, emitted after a write or an external calendar change. Guests receive it too, so the poller always sends no keys. */
export const CalendarChangedSchema = Type.Object({
    reason: Type.Union([Type.Literal("write"), Type.Literal("external")]),
    /** Wire keys of calendars that changed. Empty means every open view should refresh. */
    calendarKeys: Type.Array(NonEmpty(8), { maxItems: MAX_CALENDARS }),
    at: NonEmpty(32),
}, { additionalProperties: false });
/** `calendar-checked` carries nothing: it means every calendar read cleanly just now, and the page dates it by its own clock. */
export const CalendarCheckedSchema = Type.Object({}, { additionalProperties: false });
export const WeekPayloadSchema = Type.Object({
    mode: Type.Union([Type.Literal("demo"), Type.Literal("live")]),
    /** Local dates in `timezone`; `end` is the last day of the week, inclusive. */
    range: Type.Object({ start: IsoDate, end: IsoDate, timezone: Text(64) }),
    today: IsoDate,
    days: Type.Array(Type.Object({ date: IsoDate, isToday: Type.Boolean(), eventIds: Type.Array(Text(EVENT_ID_MAX), { maxItems: MAX_WEEK_EVENTS }) }), { minItems: 7, maxItems: 7 }),
    members: Type.Array(MemberSchema, { maxItems: MAX_MEMBERS }),
    calendars: Type.Array(CalendarRefSchema, { maxItems: MAX_CALENDARS }),
    /**
     * `warnings` names calendars that failed to load while the rest still show.
     * `hidden` means the household has calendars and none are this viewer's.
     */
    calendar: Type.Union([
        Type.Object({
            status: Type.Literal("ok"),
            data: Type.Array(FamilyEventSchema, { maxItems: MAX_WEEK_EVENTS }),
            warnings: Type.Array(Text(MESSAGE_MAX), { maxItems: MAX_CALENDARS }),
        }),
        Type.Object({ status: Type.Literal("hidden") }),
        Unconfigured,
        Failed,
    ]),
    weather: WeatherStateSchema,
    /** The viewer's connection may write (operator.write or operator.admin): the page shows edit controls. */
    canEdit: Type.Boolean(),
    /** A viewer who may write, while the Google grant is read-only: the page says so instead. */
    calendarsReadOnly: Type.Boolean(),
});
/**
 * Input to the `family.week` Gateway method. It is not a feature query: a
 * session action carries no caller identity, so the week is served by a plugin
 * Gateway method that filters by who signed in.
 */
export const WEEK_METHOD = "family.week";
export const WeekInputSchema = Type.Object({ start: Type.Optional(IsoDate) }, { additionalProperties: false });
/** `family_schedule` reads at most a week, or 90 days for a title lookup, and lists 40 items before "+N more". */
export const SCHEDULE_DAYS_MAX = 7;
export const LOOKUP_DAYS_MAX = 90;
export const SCHEDULE_ITEMS_MAX = 40;
export const QUERY_MAX = 100;
/** The usual and classes lines are cut at an item boundary to fit, ending "+N more". */
export const USUAL_MAX = 2000;
export const CLASSES_LINE_MAX = 500;
export const ScheduleInputSchema = Type.Object({
    start: Type.Optional(Type.String({ pattern: ISO_DATE, description: "First day, YYYY-MM-DD in the family's timezone. Defaults to today." })),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: LOOKUP_DAYS_MAX, description: "How many days from start. Defaults to 1, or 90 with a query. At most 7, or 90 with a query." })),
    member: Type.Optional(Type.String({
        minLength: 1,
        maxLength: LABEL_MAX,
        description: 'Only calendars this person owns: a roster profileId, or "me" for the person asking on Discord.',
    })),
    query: Type.Optional(Type.String({
        minLength: 1,
        maxLength: QUERY_MAX,
        description: 'Find events whose title has every one of these words, such as "dentist". Lists matches instead of sections.',
    })),
}, { additionalProperties: false });
const ScheduleItemSchema = Type.Object({
    /** The wire id (`c0/...`) the calendar write tools take. A merged event's is its first copy's. */
    id: Text(EVENT_ID_MAX),
    title: Text(TITLE_MAX),
    /** "8:05 AM" for a timed event; all-day events carry `allDay` instead. */
    time: Type.Optional(Text(16)),
    allDay: Type.Optional(Type.Literal(true)),
    /** "Fri Oct 9", only when the range is longer than one day. */
    date: Type.Optional(Text(16)),
    /** "Fri Oct 9" for homework and uniforms. */
    due: Type.Optional(Text(16)),
    /** Display names of the calendar owners, never profileIds. */
    owners: Type.Array(Text(LABEL_MAX), { maxItems: MAX_MEMBERS }),
}, { additionalProperties: false });
export const SCHEDULE_SECTIONS = ["not the usual", "homework", "uniforms"];
const ScheduleWarnings = Type.Optional(Type.Array(Text(MESSAGE_MAX), { maxItems: MAX_CALENDARS }));
/** One of: an error and nothing else, one line when nothing is on, or the sections. */
export const ScheduleOutputSchema = Type.Union([
    Type.Object({ error: Text(MESSAGE_MAX) }, { additionalProperties: false }),
    Type.Object({ note: Text(MESSAGE_MAX), warnings: ScheduleWarnings }, { additionalProperties: false }),
    Type.Object({
        sections: Type.Array(Type.Object({
            name: Type.Union([Type.Literal("not the usual"), Type.Literal("homework"), Type.Literal("uniforms"), Type.Literal("matches")]),
            items: Type.Array(ScheduleItemSchema, { minItems: 1, maxItems: SCHEDULE_ITEMS_MAX }),
        }, { additionalProperties: false }), { maxItems: SCHEDULE_SECTIONS.length }),
        /** One plain-text line per day, and per student when no member is named: "Calla: Math 8:30 AM · Gym 10:15 AM". */
        classes: Type.Optional(Type.Array(Type.Object({ date: Type.Optional(Text(16)), line: Text(CLASSES_LINE_MAX) }, { additionalProperties: false }), {
            minItems: 1,
            maxItems: SCHEDULE_DAYS_MAX * MAX_CALENDARS,
        })),
        usual: Type.Optional(Text(USUAL_MAX)),
        more: Type.Optional(Text(16)),
        warnings: ScheduleWarnings,
    }, { additionalProperties: false }),
]);
/** `garbage_schedule` lists curbside pickups from today through 14 days out, as Bernie's tool did. */
export const GARBAGE_DAYS = 14;
export const GARBAGE_ITEMS_MAX = 30;
/** An error, a note when nothing is due, or the pickups: "Monday, Oct 05" and "Garbage and Recycling". */
export const GarbageOutputSchema = Type.Union([
    Type.Object({ error: Text(MESSAGE_MAX) }, { additionalProperties: false }),
    Type.Object({ note: Text(MESSAGE_MAX) }, { additionalProperties: false }),
    Type.Object({
        collections: Type.Array(Type.Object({ date: Text(32), what: Text(64) }, { additionalProperties: false }), {
            minItems: 1,
            maxItems: GARBAGE_ITEMS_MAX,
        }),
    }, { additionalProperties: false }),
]);
export const contract = defineFeatureContract({
    pluginId: "oc-family-pack",
    operations: {
        "family.members": {
            kind: "query",
            description: "Read the roster a picker shows: profile id, display name, color, and role for each person.",
            input: EmptyInput,
            output: MembersPayloadSchema,
        },
        "family.weather": {
            kind: "query",
            description: "Read the local Environment Canada weather card, or why it is not available.",
            input: EmptyInput,
            output: WeatherStateSchema,
        },
        "family.schedule": {
            kind: "query",
            description: "Read the family calendar for a day range, sorted the way a parent scans it: not the usual, homework (with due dates), uniforms, " +
                "a classes line per day, then one line of the usual routine. Empty sections are left out. With query, lists matching events instead. " +
                "Shows only the calendars the person asking may see. Write the reply yourself from these fields; never add events.",
            input: ScheduleInputSchema,
            output: ScheduleOutputSchema,
            tool: { name: "family_schedule", label: "Family schedule" },
        },
        "family.today": {
            kind: "query",
            description: "Read what is urgent today: at most three lines (an event starting within four hours, the next school class, and garbage tomorrow when a collection calendar is set), " +
                "or one quiet-day line when nothing is. exceptions are today's noteworthy events. Shows only the calendars the person asking may see. " +
                "Write the reply from these fields; never add events.",
            input: EmptyInput,
            output: TodayPayloadSchema,
            tool: { name: "family_today", label: "Today" },
        },
        "family.garbage": {
            kind: "query",
            description: "Read the curbside garbage, green bin and recycling pickups from today through the next 14 days, from the city's collection calendar. " +
                "Dates are in the family's timezone. Write the reply yourself from these fields.",
            input: EmptyInput,
            output: GarbageOutputSchema,
            tool: { name: "garbage_schedule", label: "Garbage day" },
        },
        [CALENDAR_WRITE_ACTION]: {
            kind: "action",
            description: "Change, move or delete one event from the page (or add one). Each submit carries its own requestId. Answers with the line to show.",
            input: CalendarWriteSchema,
            output: CalendarWriteResultSchema,
        },
    },
    events: {
        [CALENDAR_CHANGED_EVENT]: CalendarChangedSchema,
        [CALENDAR_CHECKED_EVENT]: CalendarCheckedSchema,
    },
});
