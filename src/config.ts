import { Type } from "typebox";
import { LINK_MAX, MAX_CALENDARS, MAX_MEMBERS } from "./contract.ts";
import type { CalendarConfig, CalendarKind, Config, Location, MemberConfig, MemberDevice, MemberRole, ReminderMode, WriteMode } from "./types.ts";

const ROLES: readonly MemberRole[] = ["parent", "kid", "guest"];
const KINDS: readonly CalendarKind[] = ["personal", "shared", "school"];
const WRITE_MODES: readonly WriteMode[] = ["on", "confirm", "off"];
const REMINDER_MODES: readonly ReminderMode[] = ["dm", "channel", "off"];
const MAX_LEADS = 8;
const MAX_LEAD_MINUTES = 7 * 24 * 60;
// Colors land in CSS custom properties, so only accept plain color syntax.
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/-]+\)|[a-zA-Z]+)$/;
/** Discord user ids are snowflakes. A mention like `<@…>` is not an id. */
export const DISCORD_ID = /^\d{17,20}$/;
/** A channel key is a short name the operator picks; it is what delivery rows store instead of the Discord id. */
const CHANNEL_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CHANNELS = 20;
const MAX_DEVICES = 32;
const MAX_ALIAS_MACS = 32;

const Name = Type.String({ minLength: 1, maxLength: 200 });
const MacInput = Type.String({ minLength: 1, maxLength: 64 });

// Structural rules the host checks before the plugin loads. parseConfig adds the
// cross-field rules (zone validity, owner references, uniqueness), lowercases
// roster ids, normalizes MACs, and fills defaults. phone and aliases
// are left to the beads that read them.
export const ConfigSchema = Type.Object(
  {
    demo: Type.Optional(Type.Boolean({ default: false })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    location: Type.Optional(
      Type.Object(
        {
          lat: Type.Number({ minimum: -90, maximum: 90 }),
          lon: Type.Number({ minimum: -180, maximum: 180 }),
          label: Type.Optional(Name),
        },
        { additionalProperties: false },
      ),
    ),
    garbageIcsUrl: Type.Optional(Type.String({ minLength: 1, maxLength: LINK_MAX })),
    channels: Type.Optional(
      Type.Record(Type.String({ pattern: CHANNEL_KEY.source }), Type.String({ minLength: 17, maxLength: 20, pattern: DISCORD_ID.source }), {
        maxProperties: MAX_CHANNELS,
        additionalProperties: false,
      }),
    ),
    summaryChannel: Type.Optional(Type.String({ pattern: CHANNEL_KEY.source })),
    reminderLeadMinutes: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: MAX_LEAD_MINUTES }), { maxItems: MAX_LEADS, default: [15] })),
    quietHours: Type.Optional(
      Type.Object(
        {
          startHour: Type.Integer({ minimum: 0, maximum: 23, default: 22 }),
          endHour: Type.Integer({ minimum: 0, maximum: 23, default: 7 }),
        },
        { additionalProperties: false },
      ),
    ),
    gogPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    writes: Type.Optional(Type.Union(WRITE_MODES.map((mode) => Type.Literal(mode)), { default: "on" })),
    members: Type.Optional(
      Type.Array(
        Type.Object(
          {
            profileId: Name,
            displayName: Name,
            role: Type.Union(ROLES.map((role) => Type.Literal(role))),
            color: Type.Optional(Type.String({ maxLength: 100, pattern: CSS_COLOR.source })),
            discordId: Type.Optional(Type.String({ minLength: 17, maxLength: 20, pattern: DISCORD_ID.source })),
            reminders: Type.Optional(Type.Union(REMINDER_MODES.map((mode) => Type.Literal(mode)), { default: "dm" })),
            devices: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    label: Name,
                    primaryMac: MacInput,
                    aliasMacs: Type.Optional(Type.Array(MacInput, { maxItems: MAX_ALIAS_MACS })),
                    source: Name,
                  },
                  { additionalProperties: false },
                ),
                { maxItems: MAX_DEVICES },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: MAX_MEMBERS },
      ),
    ),
    calendars: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 1024 }),
            label: Name,
            kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
            owners: Type.Optional(Type.Array(Name, { maxItems: MAX_MEMBERS })),
          },
          { additionalProperties: false },
        ),
        { maxItems: MAX_CALENDARS },
      ),
    ),
  },
  { additionalProperties: false },
);

export class ConfigError extends Error {
  constructor(field: string, problem: string) {
    super(`oc-family-pack config: ${field} ${problem}`);
    this.name = "ConfigError";
  }
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(field, "must be a non-empty string");
  }
  return value.trim();
}

function oneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new ConfigError(field, `must be one of ${options.join(", ")}`);
  }
  return value as T;
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(field, "must be an array");
  }
  return value;
}

function timezone(value: unknown, field: string): string {
  const zone = text(value, field);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ConfigError(field, `must be an IANA time zone such as America/Toronto (got "${zone}")`);
  }
  return zone;
}

function coordinate(value: unknown, field: string, limit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new ConfigError(field, `must be a number between -${limit} and ${limit}`);
  }
  return value;
}

function location(value: unknown): Location | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ConfigError("location", "must be an object with lat and lon");
  }
  const parsed: Location = {
    lat: coordinate(value.lat, "location.lat", 90),
    lon: coordinate(value.lon, "location.lon", 180),
  };
  if (value.label !== undefined) {
    parsed.label = text(value.label, "location.label");
  }
  return parsed;
}

/** Roster ids are stored lowercased. The trusted-proxy username is compared that way. */
function profileId(value: unknown, field: string): string {
  return text(value, field).toLowerCase();
}

/**
 * One place that turns a MAC into lowercase colon-separated form.
 * Callers downstream compare the stored string; they do not normalize again.
 * Accepts colon, hyphen, dot, or space separators, Cisco groups of four, or 12 bare hex digits.
 */
function normalizeMac(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replaceAll(/[:.\-\s]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compact)) {
    return undefined;
  }
  return compact.match(/.{2}/g)?.join(":");
}

function macAddress(value: unknown, field: string, memberName: string): string {
  const normalized = typeof value === "string" ? normalizeMac(value) : undefined;
  if (normalized === undefined) {
    throw new ConfigError(field, `must be a MAC address for ${memberName}`);
  }
  return normalized;
}

function atMost(items: unknown[], field: string, max: number): unknown[] {
  if (items.length > max) {
    throw new ConfigError(field, `must contain at most ${max} entries`);
  }
  return items;
}

function device(value: unknown, field: string, memberName: string): MemberDevice {
  if (!isRecord(value)) {
    throw new ConfigError(field, "must be an object");
  }
  const aliasMacs = atMost(list(value.aliasMacs, `${field}.aliasMacs`), `${field}.aliasMacs`, MAX_ALIAS_MACS).map((mac, index) =>
    macAddress(mac, `${field}.aliasMacs[${index}]`, memberName),
  );
  return {
    label: text(value.label, `${field}.label`),
    primaryMac: macAddress(value.primaryMac, `${field}.primaryMac`, memberName),
    aliasMacs,
    source: text(value.source, `${field}.source`),
  };
}

function member(value: unknown, index: number): MemberConfig {
  const field = `members[${index}]`;
  if (!isRecord(value)) {
    throw new ConfigError(field, "must be an object");
  }
  const displayName = text(value.displayName, `${field}.displayName`);
  const parsed: MemberConfig = {
    profileId: profileId(value.profileId, `${field}.profileId`),
    displayName,
    role: oneOf(value.role, `${field}.role`, ROLES),
    devices: atMost(list(value.devices, `${field}.devices`), `${field}.devices`, MAX_DEVICES).map((entry, deviceIndex) =>
      device(entry, `${field}.devices[${deviceIndex}]`, displayName),
    ),
  };
  if (value.color !== undefined) {
    const color = text(value.color, `${field}.color`);
    if (!CSS_COLOR.test(color)) {
      throw new ConfigError(`${field}.color`, "must be a CSS color such as #3b82f6 or oklch(0.72 0.14 245)");
    }
    parsed.color = color;
  }
  if (value.discordId !== undefined) {
    parsed.discordId = discordId(value.discordId, `${field}.discordId`);
  }
  parsed.reminders = value.reminders === undefined ? "dm" : oneOf(value.reminders, `${field}.reminders`, REMINDER_MODES);
  return parsed;
}

function calendar(value: unknown, index: number, profileIds: ReadonlySet<string>): CalendarConfig {
  const field = `calendars[${index}]`;
  if (!isRecord(value)) {
    throw new ConfigError(field, "must be an object");
  }
  // School calendars included: attribution is this list and nothing else. An omitted list stays empty.
  const owners = list(value.owners, `${field}.owners`).map((owner, i) => {
    const id = profileId(owner, `${field}.owners[${i}]`);
    if (!profileIds.has(id)) {
      throw new ConfigError(`${field}.owners[${i}]`, `"${id}" does not match any members[].profileId`);
    }
    return id;
  });
  return {
    key: `c${index}`,
    id: text(value.id, `${field}.id`),
    label: text(value.label, `${field}.label`),
    kind: oneOf(value.kind, `${field}.kind`, KINDS),
    owners,
  };
}

function feedUrl(value: unknown, field: string): string {
  const url = text(value, field);
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new ConfigError(field, "must be an http or https link to an .ics calendar (for a webcal:// link, use https:// instead)");
  }
  return url;
}

function hour(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new ConfigError(field, "must be an hour from 0 to 23");
  }
  return value;
}

function leadMinutes(value: unknown): number[] {
  if (value === undefined) return [15];
  const items = atMost(list(value, "reminderLeadMinutes"), "reminderLeadMinutes", MAX_LEADS);
  const leads: number[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > MAX_LEAD_MINUTES) {
      throw new ConfigError(`reminderLeadMinutes[${index}]`, `must be a whole number of minutes from 0 to ${MAX_LEAD_MINUTES}`);
    }
    leads.push(item);
  }
  if (new Set(leads).size !== leads.length) throw new ConfigError("reminderLeadMinutes", "must not repeat a lead time");
  return leads;
}

function quietHours(value: unknown): { startHour: number; endHour: number } {
  if (value === undefined) return { startHour: 22, endHour: 7 };
  if (!isRecord(value)) throw new ConfigError("quietHours", "must be an object with startHour and endHour");
  return { startHour: hour(value.startHour, "quietHours.startHour"), endHour: hour(value.endHour, "quietHours.endHour") };
}

function discordId(value: unknown, field: string): string {
  const id = text(value, field);
  if (!DISCORD_ID.test(id)) {
    throw new ConfigError(field, "must be a numeric Discord user id");
  }
  return id;
}

/** Discord channels by key. A key, never the id, is what config fields and delivery rows name. */
function channels(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ConfigError("channels", "must be an object of channel key to Discord channel id");
  const entries = Object.entries(value);
  if (entries.length > MAX_CHANNELS) throw new ConfigError("channels", `must contain at most ${MAX_CHANNELS} entries`);
  const parsed: Record<string, string> = {};
  for (const [key, id] of entries) {
    if (!CHANNEL_KEY.test(key)) throw new ConfigError(`channels.${key}`, "must be a key of lowercase letters, digits and hyphens, such as family-briefs");
    if (typeof id !== "string" || !DISCORD_ID.test(id.trim())) throw new ConfigError(`channels.${key}`, "must be a numeric Discord channel id");
    parsed[key] = id.trim();
  }
  return parsed;
}

function unique(values: string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ConfigError(field, `contains "${value}" more than once`);
    }
    seen.add(value);
  }
}

export function parseConfig(raw: unknown): Config {
  const value = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(value)) {
    throw new ConfigError("(root)", "must be an object");
  }
  if (value.demo !== undefined && typeof value.demo !== "boolean") {
    throw new ConfigError("demo", "must be true or false");
  }
  const demo = value.demo === true;
  const members = list(value.members, "members").map(member);
  // Profile ids are already lowercased, so "Riley" and "riley" collide here.
  unique(
    members.map((entry) => entry.profileId),
    "members[].profileId",
  );
  // Discord identity is this id matched to the sender, so two members cannot share one.
  unique(
    members.flatMap((entry) => (entry.discordId === undefined ? [] : [entry.discordId])),
    "members[].discordId",
  );
  const profileIds = new Set(members.map((entry) => entry.profileId));
  const calendars = list(value.calendars, "calendars").map((entry, index) => calendar(entry, index, profileIds));
  unique(
    calendars.map((entry) => entry.id),
    "calendars[].id",
  );
  const config: Config = {
    timezone:
      value.timezone === undefined
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : timezone(value.timezone, "timezone"),
    demo,
    gogPath: value.gogPath === undefined ? "gog" : text(value.gogPath, "gogPath"),
    writes: value.writes === undefined ? "on" : oneOf(value.writes, "writes", WRITE_MODES),
    members,
    calendars,
  };
  const parsedLocation = location(value.location);
  if (parsedLocation) {
    config.location = parsedLocation;
  }
  if (value.garbageIcsUrl !== undefined) {
    config.garbageIcsUrl = feedUrl(value.garbageIcsUrl, "garbageIcsUrl");
  }
  const parsedChannels = channels(value.channels);
  if (parsedChannels) {
    config.channels = parsedChannels;
  }
  if (value.summaryChannel !== undefined) {
    const key = text(value.summaryChannel, "summaryChannel");
    if (!parsedChannels || !Object.hasOwn(parsedChannels, key)) {
      throw new ConfigError("summaryChannel", `"${key}" does not match any key in channels`);
    }
    config.summaryChannel = key;
  }
  config.reminderLeadMinutes = leadMinutes(value.reminderLeadMinutes);
  config.quietHours = quietHours(value.quietHours);
  return config;
}
