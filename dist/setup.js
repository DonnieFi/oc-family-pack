// Guided setup: what the Family page still needs, and the one next step.
// Pure: reads the host config it is given and prints a config patch. Nothing
// here writes config, stores a password, or calls the Gateway.
import { detectAccess, outsideSignIn, people, PROFILE_STEP, ROLES, SCOPES } from "./access.js";
import { DISCORD_ID } from "./config.js";
import { WEATHER_SETUP_HINT } from "./weather-ec.js";
const CONFIG_PATH = "plugins.entries.oc-family-pack.config";
const DISCORD_HELP = "Optional. In Discord, turn on Developer Mode, then right-click the person and pick Copy User ID.";
const BAD_DISCORD = "Give each Discord ID as `--discord NAME=ID`. The ID is the number Copy User ID gives you, 17 to 20 digits long.";
const LINK_INTRO = "Then link each Discord ID to that person's profile, so the Gateway knows who's talking in Discord:";
export const PATCH_INTRO = "Check it first with `openclaw config patch --stdin --dry-run`, then run it again without `--dry-run` to apply it.";
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** The plugin's own config inside the host config, exactly as written. */
export function familyConfig(host) {
    return record(record(record(record(record(host).plugins).entries)["oc-family-pack"]).config);
}
function profileId(member) {
    const id = record(member).profileId;
    return typeof id === "string" ? id.toLowerCase() : "";
}
function named(names) {
    return names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
function accessStep(host) {
    const gateway = record(host).gateway;
    const done = !outsideSignIn(gateway) && detectAccess(gateway).missing.length === 0;
    return { name: "Access mode", done, next: "`openclaw family access`" };
}
const ADD_PARENT = "Add at least one parent with `--parent NAME`.";
/** The role `access` gave someone, read back from their `identityScopes`. Anything else is a guest. */
function grantedRole(gateway, user) {
    const scopes = record(record(record(gateway).auth).identityScopes)[user];
    const given = Array.isArray(scopes) ? scopes.map(String).sort().join(" ") : "";
    return ROLES.find((role) => [...SCOPES[role]].sort().join(" ") === given) ?? "guest";
}
/**
 * `access lan` replaces the whole `allowUsers` list, so the command names every
 * member and everyone already allowed. Nobody gets dropped by re-running it.
 */
function accessCommand(gateway, members, allowed) {
    const roster = new Map(members.map((member) => [profileId(member), String(record(member).role)]));
    for (const user of allowed)
        if (!roster.has(user))
            roster.set(user, grantedRole(gateway, user));
    const flags = [...roster].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([user, role]) => `--${role} ${user}`);
    return `openclaw family access lan ${flags.join(" ")}`;
}
function membersStep(host, members) {
    const name = "Members";
    if (!members.some((member) => record(member).role === "parent"))
        return { name, done: false, next: ADD_PARENT };
    const gateway = record(host).gateway;
    if (detectAccess(gateway).mode === "lan") {
        const list = record(record(record(gateway).auth).trustedProxy).allowUsers;
        const allowed = Array.isArray(list) ? list.map((user) => String(user).toLowerCase()) : [];
        const locked = members.map(profileId).filter((id) => !allowed.includes(id));
        if (locked.length > 0) {
            const who = named(locked);
            return {
                name,
                done: false,
                next: `${who} ${locked.length === 1 ? "isn't" : "aren't"} in \`allowUsers\` yet, so they can't sign in. Run \`openclaw family access lan\` again with everyone in the family, so the new list includes ${who}.\n\`${accessCommand(gateway, members, allowed)}\``,
            };
        }
    }
    return { name, done: true, next: "" };
}
function steps(host, gog, hostZone) {
    const config = familyConfig(host);
    const location = record(config.location);
    const members = Array.isArray(config.members) ? config.members : [];
    const calendars = Array.isArray(config.calendars) ? config.calendars : [];
    return [
        accessStep(host),
        {
            name: "Timezone",
            // Set in the config, not filled in from this machine's zone at load.
            done: typeof config.timezone === "string" && config.timezone.length > 0,
            next: `Set \`timezone\`, like \`America/Halifax\`. Until then the week uses this machine's time zone.\n\`openclaw config set ${CONFIG_PATH}.timezone ${hostZone}\``,
        },
        {
            name: "Location",
            done: typeof location.lat === "number" && typeof location.lon === "number",
            next: `${WEATHER_SETUP_HINT}\n\`openclaw config set ${CONFIG_PATH}.location '{"lat":LAT,"lon":LON}' --strict-json\`\nReplace LAT and LON with your home's latitude and longitude, like \`44.65\` and \`-63.57\`.`,
        },
        membersStep(host, members),
        { name: "Calendars", done: gog.status === "ready" && calendars.length > 0, next: "`openclaw family gog`" },
    ];
}
/** `NAME=ID` pairs from `--discord`, checked before anything is printed. */
function discordIds(pairs) {
    const ids = new Map();
    for (const pair of pairs) {
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).toLowerCase();
        const id = pair.slice(at + 1);
        if (at < 1 || !DISCORD_ID.test(id))
            return { error: BAD_DISCORD };
        if (ids.has(name))
            return { error: `\`${name}\` has more than one Discord ID. Give each person one.` };
        ids.set(name, id);
    }
    return { ids };
}
/**
 * New members go after the existing ones, which are copied exactly as written:
 * `config patch` replaces whole arrays, so leaving one out would delete it.
 * A Discord ID changes only that person's `discordId`.
 */
function membersPatch(existing, list, ids) {
    const taken = new Set(existing.map(profileId));
    const skipped = list.filter((person) => taken.has(person.name)).map((person) => `${person.name} is already set up, so that entry was left as it is.`);
    const added = list
        .filter((person) => !taken.has(person.name))
        .map((person) => ({
        profileId: person.name,
        displayName: person.name[0]?.toUpperCase() + person.name.slice(1),
        role: person.role,
        ...(ids.has(person.name) ? { discordId: ids.get(person.name) } : {}),
    }));
    const known = new Set([...taken, ...added.map((member) => member.profileId)]);
    const stranger = [...ids.keys()].find((name) => !known.has(name));
    if (stranger)
        return { skipped, error: `\`${stranger}\` isn't in the family yet. Add them with \`--parent\`, \`--kid\` or \`--guest\` in the same command.` };
    let changed = added.length;
    const kept = existing.map((entry) => {
        const id = ids.get(profileId(entry));
        if (id === undefined || record(entry).discordId === id)
            return entry;
        changed += 1;
        return { ...record(entry), discordId: id };
    });
    const members = [...kept, ...added];
    // parseConfig refuses a shared id, so catch it here instead of in the patch.
    const owners = new Map();
    for (const member of members) {
        const id = record(member).discordId;
        if (typeof id !== "string")
            continue;
        const owner = owners.get(id);
        if (owner)
            return { skipped, error: `${owner} and ${profileId(member)} have the same Discord ID. Each person needs their own.` };
        owners.set(id, profileId(member));
    }
    if (changed === 0)
        return { skipped };
    const patch = { plugins: { entries: { "oc-family-pack": { config: { members } } } } };
    return { skipped, patch: JSON.stringify(patch, null, 2) };
}
/** The Discord account the family uses: the only one configured, or OpenClaw's default. */
function discordAccount(host) {
    const accounts = Object.keys(record(record(record(record(host).channels).discord).accounts));
    if (accounts.length > 1)
        return "ACCOUNT";
    return accounts[0] ?? "default";
}
/** `users.linkChannelIdentity` params for one person. The smoke sends exactly these. */
export function discordLink(profile, accountId, senderId) {
    return { profileId: profile, identity: { channelId: "discord", accountId, senderId } };
}
function linkLines(host, ids) {
    if (ids.size === 0 || detectAccess(record(host).gateway).mode !== "lan")
        return [];
    const account = discordAccount(host);
    return [
        "",
        LINK_INTRO,
        ...[...ids].map(([name, id]) => `openclaw gateway call users.linkChannelIdentity --params '${JSON.stringify(discordLink(`PROFILE_${name}`, account, id))}'`),
        PROFILE_STEP,
        ...(account === "ACCOUNT" ? ["Replace ACCOUNT with the `channels.discord.accounts` entry the family uses."] : []),
    ];
}
/** Members without a Discord ID, as the optional command that adds them. */
function discordHint(host) {
    const members = familyConfig(host).members;
    const missing = (Array.isArray(members) ? members : []).filter((member) => record(member).discordId === undefined).map(profileId);
    if (missing.length === 0)
        return [];
    return ["", `\`openclaw family setup --discord ${missing.map((name) => `${name}=DISCORD_ID_${name}`).join(" ")}\``, DISCORD_HELP];
}
/** `openclaw family setup`: a Done or To do line per part, then the one next step. */
export function planSetup(host, input, gog, hostZone) {
    const list = steps(host, gog, hostZone);
    const checklist = list.map((step) => `${step.name}: ${step.done ? "Done" : "To do"}`);
    const named = (input.parent ?? []).length + (input.kid ?? []).length + (input.guest ?? []).length > 0;
    const asked = named || (input.discord ?? []).length > 0;
    if (asked) {
        const found = named ? people(input) : { list: [] };
        if ("error" in found)
            return { ok: false, text: found.error };
        const parsed = discordIds(input.discord ?? []);
        if ("error" in parsed)
            return { ok: false, text: parsed.error };
        const existing = familyConfig(host).members;
        const { skipped, patch, error } = membersPatch(Array.isArray(existing) ? existing : [], found.list, parsed.ids);
        if (error)
            return { ok: false, text: error };
        if (patch) {
            return { ok: false, text: [...skipped, PATCH_INTRO, patch, ...linkLines(host, parsed.ids), "", ...checklist].join("\n") };
        }
        checklist.unshift(...skipped, "No changes to make.", "");
    }
    const optional = asked ? [] : discordHint(host);
    const next = list.find((step) => !step.done);
    if (!next)
        return { ok: true, text: [...checklist, ...optional, "", "Everything is set up."].join("\n") };
    return { ok: false, text: [...checklist, ...optional, "", `Next: ${next.next}`].join("\n") };
}
