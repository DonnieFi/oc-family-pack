import { Type } from "typebox";
import { LINK_MAX, MAX_CALENDARS, MAX_MEMBERS } from "./contract.js";
const ROLES = ["parent", "kid", "guest"];
const KINDS = ["personal", "shared", "school"];
const WRITE_MODES = ["on", "confirm", "off"];
const REMINDER_MODES = ["dm", "channel", "off"];
const MAX_LEADS = 8;
const MAX_LEAD_MINUTES = 7 * 24 * 60;
const MAX_PHRASES = 16;
const MAX_PHRASE = 40;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
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
// roster ids, normalizes MACs, and fills defaults. Phone is stored on the
// card. An observed address is rejected; a reservation is only stored.
export const ConfigSchema = Type.Object({
    demo: Type.Optional(Type.Boolean({ default: false })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    location: Type.Optional(Type.Object({
        lat: Type.Number({ minimum: -90, maximum: 90 }),
        lon: Type.Number({ minimum: -180, maximum: 180 }),
        label: Type.Optional(Name),
    }, { additionalProperties: false })),
    garbageIcsUrl: Type.Optional(Type.String({ minLength: 1, maxLength: LINK_MAX })),
    channels: Type.Optional(Type.Record(Type.String({ pattern: CHANNEL_KEY.source }), Type.String({ minLength: 17, maxLength: 20, pattern: DISCORD_ID.source }), {
        maxProperties: MAX_CHANNELS,
        additionalProperties: false,
    })),
    summaryChannel: Type.Optional(Type.String({ pattern: CHANNEL_KEY.source })),
    reminderLeadMinutes: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: MAX_LEAD_MINUTES }), { maxItems: MAX_LEADS, default: [15] })),
    quietHours: Type.Optional(Type.Object({
        startHour: Type.Integer({ minimum: 0, maximum: 23, default: 22 }),
        endHour: Type.Integer({ minimum: 0, maximum: 23, default: 7 }),
    }, { additionalProperties: false })),
    morningTime: Type.Optional(Type.String({ pattern: CLOCK.source })),
    afterSchoolTime: Type.Optional(Type.String({ pattern: CLOCK.source })),
    weekendPreviewTime: Type.Optional(Type.String({ pattern: CLOCK.source })),
    weekendPreviewWeekday: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
    schoolHints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_PHRASE }), { maxItems: MAX_PHRASES })),
    closedDayPhrases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_PHRASE }), { maxItems: MAX_PHRASES })),
    gogPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    writes: Type.Optional(Type.Union(WRITE_MODES.map((mode) => Type.Literal(mode)), { default: "confirm" })),
    members: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Name),
        name: Type.Optional(Name),
        displayName: Type.Optional(Name),
        profileId: Type.Optional(Name),
        login: Type.Optional(Name),
        gatewayProfileId: Type.Optional(Name),
        email: Type.Optional(Type.String({ minLength: 3, maxLength: 254 })),
        phone: Type.Optional(Type.String({ minLength: 7, maxLength: 32 })),
        role: Type.Optional(Type.Union(ROLES.map((role) => Type.Literal(role)))),
        color: Type.Optional(Type.String({ maxLength: 100, pattern: CSS_COLOR.source })),
        discordId: Type.Optional(Type.String({ minLength: 17, maxLength: 20, pattern: DISCORD_ID.source })),
        reminders: Type.Optional(Type.Union(REMINDER_MODES.map((mode) => Type.Literal(mode)), { default: "dm" })),
        devices: Type.Optional(Type.Array(Type.Object({
            id: Type.Optional(Name),
            label: Name,
            hostname: Type.Optional(Name),
            primaryMac: MacInput,
            aliasMacs: Type.Optional(Type.Array(MacInput, { maxItems: MAX_ALIAS_MACS })),
            source: Name,
            sharedWith: Type.Optional(Type.Array(Name, { maxItems: MAX_MEMBERS })),
            reservation: Type.Optional(Type.Object({
                address: Type.String({ minLength: 2, maxLength: 64, description: "Configured IPv4 address; IPv6 and observed addresses are not supported." }),
                network: Type.Optional(Name),
                source: Name,
            }, { additionalProperties: false })),
        }, { additionalProperties: false }), { maxItems: MAX_DEVICES })),
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
/** Roster ids are stored lowercased. The trusted-proxy username is compared that way. */
function profileId(value, field) {
    return text(value, field).toLowerCase();
}
/**
 * One place that turns a MAC into lowercase colon-separated form.
 * Callers downstream compare the stored string; they do not normalize again.
 * Accepts colon, hyphen, dot, or space separators, Cisco groups of four, or 12 bare hex digits.
 */
function normalizeMac(value) {
    const compact = value.trim().toLowerCase().replaceAll(/[:.\-\s]/g, "");
    if (!/^[0-9a-f]{12}$/.test(compact)) {
        return undefined;
    }
    return compact.match(/.{2}/g)?.join(":");
}
function macAddress(value, field, memberName) {
    const normalized = typeof value === "string" ? normalizeMac(value) : undefined;
    if (normalized === undefined) {
        throw new ConfigError(field, `must be a MAC address for ${memberName}`);
    }
    return normalized;
}
function atMost(items, field, max) {
    if (items.length > max) {
        throw new ConfigError(field, `must contain at most ${max} entries`);
    }
    return items;
}
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
function reservation(value, field, deviceLabel) {
    if (!isRecord(value))
        throw new ConfigError(field, "must be an object");
    if ("observed" in value || "observedAddress" in value) {
        throw new ConfigError(field, "records a configured reservation only. An observed address is not stored");
    }
    const address = text(value.address, `${field}.address`);
    if (!IPV4.test(address)) {
        throw new MemberError(`${deviceLabel}'s reserved address must be an IPv4 address. Check it and try again.`);
    }
    const parsed = { address, source: text(value.source, `${field}.source`) };
    if (value.network !== undefined)
        parsed.network = text(value.network, `${field}.network`);
    return parsed;
}
function device(value, field, memberName) {
    if (!isRecord(value)) {
        throw new ConfigError(field, "must be an object");
    }
    if ("observed" in value || "observedAddress" in value) {
        throw new ConfigError(field, "records a configured reservation only. An observed address is not stored");
    }
    const label = text(value.label, `${field}.label`);
    const id = value.id !== undefined ? profileId(value.id, `${field}.id`) : slugOf(label);
    if (id === "")
        throw new ConfigError(`${field}.id`, `can't be made from the label ${label}. Give ${label} an id.`);
    const aliasMacs = atMost(list(value.aliasMacs, `${field}.aliasMacs`), `${field}.aliasMacs`, MAX_ALIAS_MACS).map((mac, index) => macAddress(mac, `${field}.aliasMacs[${index}]`, memberName));
    const primaryMac = macAddress(value.primaryMac, `${field}.primaryMac`, memberName);
    const parsed = {
        id,
        label,
        primaryMac,
        aliasMacs,
        source: text(value.source, `${field}.source`),
        sharedWith: atMost(list(value.sharedWith, `${field}.sharedWith`), `${field}.sharedWith`, MAX_MEMBERS).map((owner, index) => profileId(owner, `${field}.sharedWith[${index}]`)),
    };
    if (value.hostname !== undefined)
        parsed.hostname = text(value.hostname, `${field}.hostname`);
    if (value.reservation !== undefined)
        parsed.reservation = reservation(value.reservation, `${field}.reservation`, label);
    return parsed;
}
/** A plain load error, in ux's words, that names no field and repeats no value. */
export class MemberError extends ConfigError {
    constructor(message) {
        super("members", "");
        this.message = message;
    }
}
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[0-9][0-9 ().-]{5,22}[0-9]$/;
/** Trimmed and lowercased, or a MemberError that does not repeat the address. */
export function memberEmail(value, displayName) {
    const email = value.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email))
        throw new MemberError(`${displayName}'s email doesn't look right. Check it and try again.`);
    return email;
}
/** Trimmed, or a MemberError that does not repeat the number. Stored only; nothing sends it. */
export function memberPhone(value, displayName) {
    const phone = value.trim();
    if (!PHONE_SHAPE.test(phone))
        throw new MemberError(`${displayName}'s phone doesn't look right. Check it and try again.`);
    return phone;
}
/**
 * The household id, the login, and whether `id` was written down.
 * `login` and `profileId` are the same trusted-proxy username. An omitted id
 * is still the login, else a slug of the name, so an old roster keeps its owners.
 */
export function readMemberIdentity(value, field) {
    const displayName = text(value.name ?? value.displayName, `${field}.name`);
    const fromLogin = value.login === undefined ? undefined : profileId(value.login, `${field}.login`);
    const fromProfile = value.profileId === undefined ? undefined : profileId(value.profileId, `${field}.profileId`);
    if (fromLogin !== undefined && fromProfile !== undefined && fromLogin !== fromProfile) {
        throw new MemberError(`${displayName}'s login and profileId don't match. Use one login.`);
    }
    const login = fromLogin ?? fromProfile;
    const explicitId = value.id !== undefined && !(typeof value.id === "string" && value.id.trim() === "");
    const id = explicitId ? profileId(value.id, `${field}.id`) : (login ?? slugOf(displayName));
    if (id === "")
        throw new ConfigError(`${field}.id`, `can't be made from the name ${displayName}. Give ${displayName} an id.`);
    const identity = { displayName, id, explicitId };
    if (login !== undefined)
        identity.login = login;
    if (value.gatewayProfileId !== undefined)
        identity.gatewayProfileId = text(value.gatewayProfileId, `${field}.gatewayProfileId`);
    return identity;
}
/** A lowercase slug of a name: "Riley Morgan" is riley-morgan. */
export function slugOf(name) {
    return name
        .normalize("NFKD")
        .replaceAll(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replaceAll(/[^a-z0-9._-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");
}
function member(value, index) {
    const field = `members[${index}]`;
    if (!isRecord(value)) {
        throw new ConfigError(field, "must be an object");
    }
    // name is the field; displayName is the 0.2.0 spelling and still loads.
    const identity = readMemberIdentity(value, field);
    const { displayName, id } = identity;
    const parsed = {
        id,
        displayName,
        role: value.role === undefined ? "guest" : oneOf(value.role, `${field}.role`, ROLES),
        devices: atMost(list(value.devices, `${field}.devices`), `${field}.devices`, MAX_DEVICES).map((entry, deviceIndex) => device(entry, `${field}.devices[${deviceIndex}]`, displayName)),
    };
    if (identity.login !== undefined)
        parsed.profileId = identity.login;
    if (identity.gatewayProfileId !== undefined)
        parsed.gatewayProfileId = identity.gatewayProfileId;
    if (value.email !== undefined) {
        if (typeof value.email !== "string")
            throw new MemberError(`${displayName}'s email doesn't look right. Check it and try again.`);
        parsed.email = memberEmail(value.email, displayName);
    }
    if (value.phone !== undefined) {
        if (typeof value.phone !== "string")
            throw new MemberError(`${displayName}'s phone doesn't look right. Check it and try again.`);
        parsed.phone = memberPhone(value.phone, displayName);
    }
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
function calendar(value, index, profileIds) {
    const field = `calendars[${index}]`;
    if (!isRecord(value)) {
        throw new ConfigError(field, "must be an object");
    }
    // School calendars included: attribution is this list and nothing else. An omitted list stays empty.
    const owners = list(value.owners, `${field}.owners`).map((owner, i) => {
        const id = profileId(owner, `${field}.owners[${i}]`);
        if (!profileIds.has(id)) {
            throw new ConfigError(`${field}.owners[${i}]`, `"${id}" does not match any members[].id`);
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
function feedUrl(value, field) {
    const url = text(value, field);
    let protocol;
    try {
        protocol = new URL(url).protocol;
    }
    catch {
        protocol = undefined;
    }
    if (protocol !== "https:" && protocol !== "http:") {
        throw new ConfigError(field, "must be an http or https link to an .ics calendar (for a webcal:// link, use https:// instead)");
    }
    return url;
}
function hour(value, field) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23) {
        throw new ConfigError(field, "must be an hour from 0 to 23");
    }
    return value;
}
function leadMinutes(value) {
    if (value === undefined)
        return [15];
    const items = atMost(list(value, "reminderLeadMinutes"), "reminderLeadMinutes", MAX_LEADS);
    const leads = [];
    for (const [index, item] of items.entries()) {
        if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > MAX_LEAD_MINUTES) {
            throw new ConfigError(`reminderLeadMinutes[${index}]`, `must be a whole number of minutes from 0 to ${MAX_LEAD_MINUTES}`);
        }
        leads.push(item);
    }
    if (new Set(leads).size !== leads.length)
        throw new ConfigError("reminderLeadMinutes", "must not repeat a lead time");
    return leads;
}
function clock(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !CLOCK.test(value.trim())) {
        throw new ConfigError(field, "must be HH:MM in 24-hour time, such as 07:00");
    }
    return value.trim();
}
function weekdayNumber(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) {
        throw new ConfigError(field, "must be a weekday number from 0 (Sunday) to 6 (Saturday)");
    }
    return value;
}
function phrases(value, field) {
    const items = atMost(list(value, field), field, MAX_PHRASES);
    const parsed = items.map((item, index) => {
        const phrase = text(item, `${field}[${index}]`).toLowerCase();
        if ([...phrase].length > MAX_PHRASE)
            throw new ConfigError(`${field}[${index}]`, `must be at most ${MAX_PHRASE} characters`);
        return phrase;
    });
    if (new Set(parsed).size !== parsed.length)
        throw new ConfigError(field, "must not repeat a phrase");
    return parsed;
}
function quietHours(value) {
    if (value === undefined)
        return { startHour: 22, endHour: 7 };
    if (!isRecord(value))
        throw new ConfigError("quietHours", "must be an object with startHour and endHour");
    return { startHour: hour(value.startHour, "quietHours.startHour"), endHour: hour(value.endHour, "quietHours.endHour") };
}
function discordId(value, field) {
    const id = text(value, field);
    if (!DISCORD_ID.test(id)) {
        throw new ConfigError(field, "must be a numeric Discord user id");
    }
    return id;
}
/** Discord channels by key. A key, never the id, is what config fields and delivery rows name. */
function channels(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        throw new ConfigError("channels", "must be an object of channel key to Discord channel id");
    const entries = Object.entries(value);
    if (entries.length > MAX_CHANNELS)
        throw new ConfigError("channels", `must contain at most ${MAX_CHANNELS} entries`);
    const parsed = {};
    for (const [key, id] of entries) {
        if (!CHANNEL_KEY.test(key))
            throw new ConfigError(`channels.${key}`, "must be a key of lowercase letters, digits and hyphens, such as family-briefs");
        if (typeof id !== "string" || !DISCORD_ID.test(id.trim()))
            throw new ConfigError(`channels.${key}`, "must be a numeric Discord channel id");
        parsed[key] = id.trim();
    }
    return parsed;
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
/** The first two members sharing a key, as ux's line. The line names people, never the shared value unless it is an id. */
function clash(members, key, line) {
    const seen = new Map();
    for (const entry of members) {
        const value = key(entry);
        if (value === undefined)
            continue;
        const first = seen.get(value);
        if (first !== undefined)
            throw new MemberError(line(first, entry.displayName, value));
        seen.set(value, entry.displayName);
    }
}
/** Preserve unambiguous legacy ids; disambiguate omitted ids by owner.
 * Explicit ids are never rewritten, even when duplicated (validation rejects them).
 * Materialize before editing labels/MACs or expanding the roster to freeze these ids.
 */
function resolveLegacyDeviceIds(members, rawMembers) {
    const counts = new Map();
    for (const member of members)
        for (const entry of member.devices) {
            counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
        }
    const reserved = new Set(counts.keys());
    const pending = [];
    for (const [memberIndex, member] of members.entries()) {
        const raw = rawMembers[memberIndex];
        const devices = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : [];
        for (const [deviceIndex, entry] of member.devices.entries()) {
            const original = devices[deviceIndex];
            if (!isRecord(original) || original.id !== undefined || counts.get(entry.id) === 1)
                continue;
            pending.push({ owner: member.id, device: entry });
        }
    }
    // Stable even if the operator reorders people or same-label devices. MACs
    // break ties but never appear in the generated id or contact-tool output.
    pending.sort((a, b) => `${a.owner}:${a.device.primaryMac}`.localeCompare(`${b.owner}:${b.device.primaryMac}`));
    for (const { owner, device } of pending) {
        const base = `${owner}-${device.id}`.slice(0, 180);
        let candidate = base;
        let suffix = 2;
        while (reserved.has(candidate))
            candidate = `${base}-${suffix++}`;
        device.id = candidate;
        reserved.add(candidate);
    }
}
/** One device record per id and per MAC. A shared device lists the other people; it is not copied. */
function checkDevices(members) {
    const memberIds = new Set(members.map((entry) => entry.id));
    const deviceIds = new Map();
    const macs = new Map();
    for (const member of members) {
        const ownIds = new Set();
        const ownMacs = new Set();
        for (const entry of member.devices) {
            if (ownIds.has(entry.id))
                throw new MemberError(`${member.displayName} has two devices with the id ${entry.id}. Give one of them its own id.`);
            ownIds.add(entry.id);
            const otherDevice = deviceIds.get(entry.id);
            if (otherDevice !== undefined) {
                throw new MemberError(`${member.displayName} and ${otherDevice} both have a device id ${entry.id}. A shared device is one record with sharedWith, not a second copy.`);
            }
            deviceIds.set(entry.id, member.displayName);
            for (const mac of [entry.primaryMac, ...entry.aliasMacs]) {
                if (ownMacs.has(mac))
                    throw new MemberError(`${member.displayName}'s ${entry.label} lists the same MAC twice.`);
                ownMacs.add(mac);
                const otherMac = macs.get(mac);
                if (otherMac !== undefined) {
                    throw new MemberError(`${member.displayName} and ${otherMac} have devices that use the same MAC. A shared device is one record with sharedWith, not a second copy.`);
                }
                macs.set(mac, member.displayName);
            }
            const shares = new Set();
            for (const share of entry.sharedWith) {
                if (share === member.id)
                    throw new MemberError(`${member.displayName}'s ${entry.label} already belongs to ${member.displayName}. sharedWith names the other people.`);
                if (!memberIds.has(share))
                    throw new MemberError(`${member.displayName}'s ${entry.label} shares with ${share}, and that person is not in the family.`);
                if (shares.has(share))
                    throw new MemberError(`${member.displayName}'s ${entry.label} repeats ${share} in sharedWith.`);
                shares.add(share);
            }
        }
    }
}
/** An id and someone else's login must not be the same string, or a reference would name two people. */
function checkIdentityNames(members) {
    for (const member of members) {
        for (const other of members) {
            if (other.id === member.id)
                continue;
            if (other.profileId === member.id) {
                throw new MemberError(`${member.id} is ${member.displayName}'s id and ${other.displayName}'s login. Use different values so a reference names one person.`);
            }
        }
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
    const rawMembers = list(value.members, "members");
    const members = rawMembers.map(member);
    // Ids and logins are already lowercased, so "Riley" and "riley" collide here.
    clash(members, (entry) => entry.profileId, (a, b) => `${a} and ${b} have the same Control UI login. Each login can belong to only one person.`);
    // Discord identity is this id matched to the sender, so two members cannot share one.
    clash(members, (entry) => entry.discordId, (a, b) => `${a} and ${b} have the same Discord account. Each Discord account can belong to only one person.`);
    clash(members, (entry) => entry.id, (a, b, id) => `Two people would share the ID ${id} (${a} and ${b}). Give one of them its own id.`);
    clash(members, (entry) => entry.gatewayProfileId, (a, b) => `${a} and ${b} have the same Gateway profile. Each profile can belong to only one person.`);
    checkIdentityNames(members);
    resolveLegacyDeviceIds(members, rawMembers);
    checkDevices(members);
    const profileIds = new Set(members.map((entry) => entry.id));
    const calendars = list(value.calendars, "calendars").map((entry, index) => calendar(entry, index, profileIds));
    unique(calendars.map((entry) => entry.id), "calendars[].id");
    const config = {
        timezone: value.timezone === undefined
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : timezone(value.timezone, "timezone"),
        demo,
        gogPath: value.gogPath === undefined ? "gog" : text(value.gogPath, "gogPath"),
        writes: value.writes === undefined ? "confirm" : oneOf(value.writes, "writes", WRITE_MODES),
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
    const morningTime = clock(value.morningTime, "morningTime");
    if (morningTime !== undefined)
        config.morningTime = morningTime;
    const afterSchoolTime = clock(value.afterSchoolTime, "afterSchoolTime");
    if (afterSchoolTime !== undefined)
        config.afterSchoolTime = afterSchoolTime;
    const weekendPreviewTime = clock(value.weekendPreviewTime, "weekendPreviewTime");
    if (weekendPreviewTime !== undefined)
        config.weekendPreviewTime = weekendPreviewTime;
    const weekendPreviewWeekday = weekdayNumber(value.weekendPreviewWeekday, "weekendPreviewWeekday");
    if (weekendPreviewWeekday !== undefined)
        config.weekendPreviewWeekday = weekendPreviewWeekday;
    config.schoolHints = phrases(value.schoolHints, "schoolHints");
    config.closedDayPhrases = phrases(value.closedDayPhrases, "closedDayPhrases");
    return config;
}
