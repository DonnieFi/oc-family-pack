import { Type } from "typebox";
import { MAX_CALENDARS, MAX_MEMBERS } from "./contract.js";
const ROLES = ["parent", "kid", "guest"];
const KINDS = ["personal", "shared", "school"];
// Colors land in CSS custom properties, so only accept plain color syntax.
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/-]+\)|[a-zA-Z]+)$/;
const Name = Type.String({ minLength: 1, maxLength: 200 });
// Structural rules the host checks before the plugin loads. parseConfig adds the
// cross-field rules (zone validity, owner references, uniqueness) and defaults.
export const ConfigSchema = Type.Object({
    demo: Type.Optional(Type.Boolean({ default: false })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    location: Type.Optional(Type.Object({
        lat: Type.Number({ minimum: -90, maximum: 90 }),
        lon: Type.Number({ minimum: -180, maximum: 180 }),
        label: Type.Optional(Name),
    }, { additionalProperties: false })),
    gogPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    members: Type.Optional(Type.Array(Type.Object({
        profileId: Name,
        displayName: Name,
        role: Type.Union(ROLES.map((role) => Type.Literal(role))),
        color: Type.Optional(Type.String({ maxLength: 100, pattern: CSS_COLOR.source })),
    }, { additionalProperties: false }), { maxItems: MAX_MEMBERS })),
    calendars: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 1024 }),
        label: Name,
        kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
        owners: Type.Optional(Type.Array(Name, { maxItems: MAX_MEMBERS })),
    }, { additionalProperties: false }), { maxItems: MAX_CALENDARS })),
}, { additionalProperties: false });
export class ConfigError extends Error {
    constructor(field, problem) {
        super(`oc-family-pack config: ${field} ${problem}`);
        this.name = "ConfigError";
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError(field, "must be a non-empty string");
    }
    return value.trim();
}
function oneOf(value, field, options) {
    if (typeof value !== "string" || !options.includes(value)) {
        throw new ConfigError(field, `must be one of ${options.join(", ")}`);
    }
    return value;
}
function list(value, field) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ConfigError(field, "must be an array");
    }
    return value;
}
function timezone(value, field) {
    const zone = text(value, field);
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
    }
    catch {
        throw new ConfigError(field, `must be an IANA time zone such as America/Toronto (got "${zone}")`);
    }
    return zone;
}
function coordinate(value, field, limit) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
        throw new ConfigError(field, `must be a number between -${limit} and ${limit}`);
    }
    return value;
}
function location(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new ConfigError("location", "must be an object with lat and lon");
    }
    const parsed = {
        lat: coordinate(value.lat, "location.lat", 90),
        lon: coordinate(value.lon, "location.lon", 180),
    };
    if (value.label !== undefined) {
        parsed.label = text(value.label, "location.label");
    }
    return parsed;
}
function member(value, index) {
    const field = `members[${index}]`;
    if (!isRecord(value)) {
        throw new ConfigError(field, "must be an object");
    }
    const parsed = {
        profileId: text(value.profileId, `${field}.profileId`),
        displayName: text(value.displayName, `${field}.displayName`),
        role: oneOf(value.role, `${field}.role`, ROLES),
    };
    if (value.color !== undefined) {
        const color = text(value.color, `${field}.color`);
        if (!CSS_COLOR.test(color)) {
            throw new ConfigError(`${field}.color`, "must be a CSS color such as #3b82f6 or oklch(0.72 0.14 245)");
        }
        parsed.color = color;
    }
    return parsed;
}
function calendar(value, index, profileIds) {
    const field = `calendars[${index}]`;
    if (!isRecord(value)) {
        throw new ConfigError(field, "must be an object");
    }
    const owners = list(value.owners, `${field}.owners`).map((owner, i) => {
        const id = text(owner, `${field}.owners[${i}]`);
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
function unique(values, field) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value)) {
            throw new ConfigError(field, `contains "${value}" more than once`);
        }
        seen.add(value);
    }
}
export function parseConfig(raw) {
    const value = raw === undefined || raw === null ? {} : raw;
    if (!isRecord(value)) {
        throw new ConfigError("(root)", "must be an object");
    }
    if (value.demo !== undefined && typeof value.demo !== "boolean") {
        throw new ConfigError("demo", "must be true or false");
    }
    const demo = value.demo === true;
    const members = list(value.members, "members").map(member);
    unique(members.map((entry) => entry.profileId), "members[].profileId");
    const profileIds = new Set(members.map((entry) => entry.profileId));
    const calendars = list(value.calendars, "calendars").map((entry, index) => calendar(entry, index, profileIds));
    unique(calendars.map((entry) => entry.id), "calendars[].id");
    const config = {
        timezone: value.timezone === undefined
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
