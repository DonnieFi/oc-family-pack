import { Type } from "typebox";
import { MAX_CALENDARS, MAX_MEMBERS } from "./contract.ts";
import type { CalendarConfig, CalendarKind, Config, Location, MemberConfig, MemberDevice, MemberRole } from "./types.ts";

const ROLES: readonly MemberRole[] = ["parent", "kid", "guest"];
const KINDS: readonly CalendarKind[] = ["personal", "shared", "school"];
// Colors land in CSS custom properties, so only accept plain color syntax.
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/-]+\)|[a-zA-Z]+)$/;
/** Discord user ids are snowflakes. A mention like `<@…>` is not an id. */
const DISCORD_ID = /^\d{17,20}$/;
const MAX_DEVICES = 32;
const MAX_ALIAS_MACS = 32;

const Name = Type.String({ minLength: 1, maxLength: 200 });
const MacInput = Type.String({ minLength: 1, maxLength: 64 });

// Structural rules the host checks before the plugin loads. parseConfig adds the
// cross-field rules (zone validity, owner references, uniqueness), lowercases
// roster ids, normalizes MACs, and fills defaults. phone, aliases, and reminders
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
    gogPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    members: Type.Optional(
      Type.Array(
        Type.Object(
          {
            profileId: Name,
            displayName: Name,
            role: Type.Union(ROLES.map((role) => Type.Literal(role))),
            color: Type.Optional(Type.String({ maxLength: 100, pattern: CSS_COLOR.source })),
            discordId: Type.Optional(Type.String({ minLength: 17, maxLength: 20, pattern: DISCORD_ID.source })),
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

function discordId(value: unknown, field: string): string {
  const id = text(value, field);
  if (!DISCORD_ID.test(id)) {
    throw new ConfigError(field, "must be a numeric Discord user id");
  }
  return id;
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
    members,
    calendars,
  };
  const parsedLocation = location(value.location);
  if (parsedLocation) {
    config.location = parsedLocation;
  }
  return config;
}
