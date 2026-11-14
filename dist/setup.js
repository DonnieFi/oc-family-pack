// Guided setup: what the Family page still needs, and the one next step.
// Pure: reads the host config it is given and prints a config patch. Nothing
// here writes config, stores a password, or calls the Gateway.
import { detectAccess, outsideSignIn, people, PROFILE_STEP, ROLES } from "./access.js";
import { ConfigError, DISCORD_ID, MemberError, memberEmail, parseConfig, readMemberIdentity, slugOf } from "./config.js";
import { AMBIGUOUS_REFERENCE, MATERIALIZE_INTRO, matchMemberIndexes, planMaterialize } from "./directory.js";
import { WEATHER_SETUP_HINT } from "./weather-ec.js";
const CONFIG_PATH = "plugins.entries.oc-family-pack.config";
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CHANNEL_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DISCORD_HELP = "Optional. In Discord, turn on Developer Mode, then right-click the person and pick Copy User ID.";
const BAD_DISCORD = "Give each Discord ID as `--discord NAME=ID`. The ID is the number Copy User ID gives you, 17 to 20 digits long.";
const BAD_EMAIL = "Give each email as `--email NAME=address`.";
const LINK_INTRO = "Then link each Discord ID to that person's profile, so the Gateway knows who's talking in Discord:";
export const PATCH_INTRO = "Check it first with `openclaw config patch --stdin --dry-run`, then run it again without `--dry-run` to apply it.";
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** The plugin's own config inside the host config, exactly as written. */
export function familyConfig(host) {
    return record(record(record(record(record(host).plugins).entries)["oc-family-pack"]).config);
}
/** Discord is the only delivery path. Email and phone are stored and do not make someone reachable. */
export const NO_CHANNEL = (name) => `${name} has no Discord account, so this version can't send them reminders or briefs. Email and phone stay on the contact card and are not notification routes.`;
/** Reminders are opt-in, so a morning brief time with no opted-in parent delivers nothing. */
export const QUIET_MORNING = "A morning brief time is set, but no parent with a Discord ID has `reminders` set to `dm` or `channel`, so the daily brief stays quiet. Set it on each parent who should get it, on the People page or in the plugin config.";
/** The member's Control UI login, if it has one. `login` and `profileId` are the same field. */
function loginOf(member) {
    const entry = record(member);
    for (const value of [entry.profileId, entry.login]) {
        if (typeof value === "string" && value.trim() !== "")
            return value.trim().toLowerCase();
    }
    return undefined;
}
/** The name setup knows a member by: its id, its login, or its name. */
function nameOf(member) {
    const entry = record(member);
    for (const value of [entry.name, entry.displayName, entry.id, entry.profileId])
        if (typeof value === "string" && value.trim() !== "")
            return value.trim();
    return "";
}
/** Members whose id is derived from a login or name; a rename would move it. */
function derivedIds(host) {
    const members = familyConfig(host).members;
    return (Array.isArray(members) ? members : [])
        .filter((member) => {
        const id = record(member).id;
        return typeof id !== "string" || id.trim() === "";
    })
        .map((member) => `${nameOf(member)} has no explicit member id. Run \`openclaw family setup --materialize-ids\` and apply its patch before changing a name or login.`);
}
/** Members with no Discord id. An email or a phone does not count as a way to reach them. */
function unreachable(host) {
    const members = familyConfig(host).members;
    return (Array.isArray(members) ? members : [])
        .filter((member) => record(member).discordId === undefined)
        .map((member) => NO_CHANNEL(nameOf(member)));
}
/** True when the config asks for a morning brief that no reachable parent is opted in to receive. */
function quietMorningBrief(host) {
    const config = familyConfig(host);
    const time = config.morningTime;
    if (typeof time !== "string" || time.trim() === "")
        return [];
    const members = Array.isArray(config.members) ? config.members : [];
    // A parent with no Discord id already gets the NO_CHANNEL warning; this one is for opted-out delivery.
    const parents = members.filter((member) => rosterRole(member) === "parent" && record(member).discordId !== undefined);
    if (parents.length === 0)
        return [];
    const reached = parents.some((member) => {
        const mode = record(member).reminders;
        return mode === "dm" || mode === "channel";
    });
    return reached ? [] : [QUIET_MORNING];
}
/** The key setup matches a member by: the login, else the id, else the slug of the name, as parseConfig derives it. */
function profileId(member) {
    const entry = record(member);
    for (const value of [entry.profileId, entry.login, entry.id]) {
        if (typeof value === "string" && value.trim() !== "")
            return value.trim().toLowerCase();
    }
    return slugOf(nameOf(member));
}
/** An email login becomes a local-part id and a plain display name, never the address. */
function memberParts(name) {
    const local = name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
    const id = slugOf(local) || slugOf(name) || local;
    return { id, displayName: local[0]?.toUpperCase() + local.slice(1) };
}
/** A token that can be used in a later setup command without printing an email. */
function referenceOf(member) {
    const entry = record(member);
    if (typeof entry.id === "string" && entry.id.trim() !== "")
        return entry.id.trim().toLowerCase();
    try {
        return readMemberIdentity(entry, "members").id;
    }
    catch {
        return profileId(member);
    }
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
/** The role a scope list grants. Parent wins, then kid; anything else is a guest. */
function roleFromScopes(scopes) {
    const given = Array.isArray(scopes) ? scopes.map(String) : [];
    if (given.includes("operator.write") || given.includes("operator.admin"))
        return "parent";
    if (given.includes("operator.sessions.write"))
        return "kid";
    return "guest";
}
/** The role `access` gave someone, read back from their `identityScopes`. */
function grantedRole(gateway, user) {
    return roleFromScopes(record(record(record(gateway).auth).identityScopes)[user]);
}
function rosterRole(member) {
    const role = record(member).role;
    return typeof role === "string" && ROLES.includes(role) ? role : "guest";
}
/**
 * `access lan` replaces the whole `allowUsers` list, so the command names every
 * member and everyone already allowed. Nobody gets dropped by re-running it.
 */
function accessCommand(gateway, members, allowed) {
    const roster = new Map(members.flatMap((member) => { const login = loginOf(member); return login ? [[login, rosterRole(member)]] : []; }));
    for (const user of allowed)
        if (!roster.has(user))
            roster.set(user, grantedRole(gateway, user));
    const flags = [...roster].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([user, role]) => `--${role} ${user}`);
    return `openclaw family access lan ${flags.join(" ")}`;
}
function membersStep(host, members) {
    const name = "Members";
    if (!members.some((member) => rosterRole(member) === "parent"))
        return { name, done: false, next: ADD_PARENT };
    const gateway = record(host).gateway;
    if (detectAccess(gateway).mode === "lan") {
        const noLogin = members.filter((member) => loginOf(member) === undefined).map(nameOf);
        if (noLogin.length > 0) {
            const who = named(noLogin);
            return {
                name,
                done: false,
                next: `${who} ${noLogin.length === 1 ? "has" : "have"} no Control UI login, so ${noLogin.length === 1 ? "that person" : "they"} can't sign in. Add \`login\` to ${noLogin.length === 1 ? "that member" : "those members"} in the plugin config (or preview the edit on the People page), then re-run \`openclaw family access lan\` with everyone.`,
            };
        }
        const list = record(record(record(gateway).auth).trustedProxy).allowUsers;
        const allowed = Array.isArray(list) ? list.map((user) => String(user).toLowerCase()) : [];
        const locked = members.flatMap((member) => loginOf(member) ?? []).filter((id) => !allowed.includes(id));
        if (locked.length > 0) {
            const who = named(locked);
            return {
                name,
                done: false,
                next: `${who} ${locked.length === 1 ? "isn't" : "aren't"} in \`allowUsers\` yet, so they can't sign in. Run \`openclaw family access lan\` again with everyone in the family, so the new list includes ${who}.\n\`${accessCommand(gateway, members, allowed)}\``,
            };
        }
        const scopes = record(record(record(gateway).auth).identityScopes);
        const mismatched = members.flatMap((member) => {
            const login = loginOf(member);
            if (login === undefined)
                return [];
            const actual = Array.isArray(scopes[login]) ? scopes[login] : [];
            return roleFromScopes(actual) === rosterRole(member)
                ? []
                : [{ label: `${nameOf(member)} (${rosterRole(member)})`, pair: `${login}=${rosterRole(member)}` }];
        });
        if (mismatched.length > 0) {
            const who = named(mismatched.map((entry) => entry.label));
            const pairs = mismatched.map((entry) => entry.pair).join(" ");
            return {
                name,
                done: false,
                next: `The Gateway scopes for ${who} don't match the roster role. Run \`openclaw family access role ${pairs}\` to update \`identityScopes\`, \`users.setRole\`, and \`members[].role\` together, or re-run the access command to set \`identityScopes\` and then run the printed \`users.setRole\` command.\n\`${accessCommand(gateway, members, allowed)}\``,
            };
        }
    }
    return { name, done: true, next: "" };
}
function clockDone(value) {
    return typeof value === "string" && CLOCK.test(value.trim());
}
function httpFeed(value) {
    if (typeof value !== "string" || value.trim() === "")
        return false;
    try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
    }
    catch {
        return false;
    }
}
/** Family channel keys whose values are Discord channel ids. */
function familyChannels(config) {
    const out = {};
    for (const [key, id] of Object.entries(record(config.channels))) {
        if (!CHANNEL_KEY.test(key) || typeof id !== "string" || !DISCORD_ID.test(id.trim()))
            continue;
        out[key] = id.trim();
    }
    return out;
}
function alertsDone(config) {
    const key = config.summaryChannel;
    if (typeof key !== "string" || !CHANNEL_KEY.test(key))
        return false;
    return familyChannels(config)[key] !== undefined;
}
/** Discord channel ids OpenClaw already allows the bot to see. The key is the id. */
function discordChannelIds(host) {
    const discord = record(record(record(host).channels).discord);
    if (discord.enabled === false)
        return [];
    const ids = [];
    for (const guild of Object.values(record(discord.guilds))) {
        for (const [id, body] of Object.entries(record(record(guild).channels))) {
            if (!DISCORD_ID.test(id) || record(body).enabled === false)
                continue;
            ids.push(id);
        }
    }
    return ids;
}
function alertKey(config) {
    const taken = new Set();
    const members = Array.isArray(config.members) ? config.members : [];
    for (const member of members) {
        const id = record(member).id;
        if (typeof id === "string" && id.trim() !== "")
            taken.add(id.trim().toLowerCase());
    }
    for (const key of ["family", "briefs", "alerts"])
        if (!taken.has(key))
            return key;
    return "household";
}
function alertsNext(host, config) {
    const intro = "Briefs and reminders post to one Discord channel. This plugin does not add a bot token. This version uses the Discord service OpenClaw already runs.";
    const existing = familyChannels(config);
    const keys = Object.keys(existing);
    if (keys.length === 1) {
        const key = keys[0] ?? "family";
        return `${intro}\n\`channels\` already has \`${key}\`. Point alerts at that channel:\n\`openclaw config set ${CONFIG_PATH}.summaryChannel ${key}\``;
    }
    if (keys.length > 1) {
        return `${intro}\nPick one key already in \`channels\` (${keys.join(", ")}):\n\`openclaw config set ${CONFIG_PATH}.summaryChannel KEY\``;
    }
    const key = alertKey(config);
    const ids = discordChannelIds(host);
    if (ids.length === 1) {
        const id = ids[0] ?? "";
        return `${intro}\nOpenClaw already has one Discord channel. Reuse it as \`${key}\`:\n\`openclaw config set ${CONFIG_PATH}.channels '{"${key}":"${id}"}' --strict-json\`\n\`openclaw config set ${CONFIG_PATH}.summaryChannel ${key}\``;
    }
    if (ids.length > 1) {
        return `${intro}\nOpenClaw has more than one Discord channel. Pick one id and set it as \`${key}\`:\n${ids.map((id) => `- \`${id}\``).join("\n")}\n\`openclaw config set ${CONFIG_PATH}.channels '{"${key}":"CHANNEL_ID"}' --strict-json\`\n\`openclaw config set ${CONFIG_PATH}.summaryChannel ${key}\``;
    }
    return `${intro}\nNo Discord channel is configured on the Gateway yet. After you add one, set \`channels.${key}\` to its id and \`summaryChannel\` to \`${key}\`.\n\`openclaw config set ${CONFIG_PATH}.channels '{"${key}":"CHANNEL_ID"}' --strict-json\`\n\`openclaw config set ${CONFIG_PATH}.summaryChannel ${key}\``;
}
function clockNext(field, detail, example) {
    return `${detail}\nLeave it unset to keep this brief off.\n\`openclaw config set ${CONFIG_PATH}.${field} ${example}\``;
}
function garbageNext() {
    return `Optional city collection calendar. \`garbage_schedule\` and the daily brief's garbage line use it. The rest of the plugin works without it.\nUse an http or https \`.ics\` link. For a \`webcal://\` link, use \`https://\` instead.\n\`openclaw config set ${CONFIG_PATH}.garbageIcsUrl 'https://example.com/collection.ics'\``;
}
function optionalPiece(name, done, next) {
    return { name, done, next, optional: true };
}
/** Configured agent IDs on the Gateway and any single marked default. */
export function hostAgents(host) {
    const agents = record(record(host).agents);
    const explicit = agents.ownership === "explicit";
    if (Object.hasOwn(agents, "entries") && agents.entries !== undefined) {
        const entries = record(agents.entries);
        const ids = [];
        const defaults = [];
        for (const [rawId, rawEntry] of Object.entries(entries)) {
            const id = rawId.trim().toLowerCase();
            if (id === "")
                continue;
            if (!ids.includes(id))
                ids.push(id);
            if (!explicit && record(rawEntry).default === true)
                defaults.push(id);
        }
        const defaultId = defaults.length === 1 ? defaults[0] : ids.length === 1 ? ids[0] : undefined;
        return { ids, ...(defaultId !== undefined ? { defaultId } : {}) };
    }
    if (Object.hasOwn(agents, "list") && Array.isArray(agents.list)) {
        const ids = [];
        const defaults = [];
        for (const rawEntry of agents.list) {
            const entry = record(rawEntry);
            const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
            if (id === "")
                continue;
            if (!ids.includes(id))
                ids.push(id);
            if (!explicit && entry.default === true)
                defaults.push(id);
        }
        const defaultId = defaults.length === 1 ? defaults[0] : ids.length === 1 ? ids[0] : undefined;
        return { ids, ...(defaultId !== undefined ? { defaultId } : {}) };
    }
    return { ids: ["main"], defaultId: "main" };
}
function agentStep(host, config) {
    const agents = hostAgents(host);
    const configured = typeof config.agentId === "string" && config.agentId.trim() !== "" ? config.agentId.trim().toLowerCase() : undefined;
    if (agents.ids.length <= 1 && configured === undefined)
        return [];
    const chosen = configured !== undefined ? agents.ids.includes(configured) : agents.defaultId !== undefined;
    const suggestion = agents.ids.includes("main") ? "main" : (agents.ids[0] ?? "main");
    const detail = configured !== undefined && !agents.ids.includes(configured)
        ? `\`agentId\` is set to \`${configured}\`, which is not one of the configured agents (${agents.ids.join(", ")}).`
        : `OpenClaw has more than one agent (${agents.ids.join(", ")}). Pick the household agent for briefs and kid/guest chat:`;
    return [
        {
            name: "Agent",
            done: chosen,
            next: `${detail}\n\`openclaw config set ${CONFIG_PATH}.agentId ${suggestion}\``,
        },
    ];
}
export function setupSteps(host, gog, hostZone) {
    const config = familyConfig(host);
    const location = record(config.location);
    const members = Array.isArray(config.members) ? config.members : [];
    const calendars = Array.isArray(config.calendars) ? config.calendars : [];
    const seeing = new Set(members.filter((member) => rosterRole(member) !== "guest").map(referenceOf));
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
        {
            name: "Calendars",
            done: gog.status === "ready" &&
                calendars.length > 0 &&
                calendars.every((calendar) => {
                    const entry = record(calendar);
                    if (entry.kind === "shared")
                        return true;
                    const owners = Array.isArray(entry.owners) ? entry.owners.map((owner) => String(owner).toLowerCase()) : [];
                    return owners.some((owner) => seeing.has(owner));
                }),
            next: (() => {
                const missing = calendars.flatMap((calendar) => {
                    const entry = record(calendar);
                    const owners = Array.isArray(entry.owners) ? entry.owners.map((owner) => String(owner).toLowerCase()) : [];
                    return (entry.kind === "personal" || entry.kind === "school") && !owners.some((owner) => seeing.has(owner))
                        ? [String(entry.label ?? entry.id ?? "a calendar")]
                        : [];
                });
                return missing.length > 0
                    ? `Give ${named(missing)} an owner who is a parent or kid, not a guest, so the right person can see it.`
                    : "`openclaw family gog`";
            })(),
        },
        ...agentStep(host, config),
        optionalPiece("Alerts", alertsDone(config), alertsNext(host, config)),
        optionalPiece("Morning brief", clockDone(config.morningTime), clockNext("morningTime", "Weekday morning direct message to parents who set `reminders` to `dm` or `channel`. It stays quiet while every parent is `off`.", "07:00")),
        optionalPiece("After-school brief", clockDone(config.afterSchoolTime), clockNext("afterSchoolTime", "Weekday after-school post to the summary channel. It stays quiet until `summaryChannel` is set.", "15:30")),
        optionalPiece("Weekend preview", clockDone(config.weekendPreviewTime), clockNext("weekendPreviewTime", "Weekend preview posted to the summary channel. It runs on Friday unless you set `weekendPreviewWeekday` (`0` is Sunday and `6` is Saturday).", "16:00")),
        optionalPiece("Garbage calendar", httpFeed(config.garbageIcsUrl), garbageNext()),
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
/** `NAME=address` pairs from `--email`. A bad address is not repeated. */
function emailsOf(pairs) {
    const emails = new Map();
    for (const pair of pairs) {
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).toLowerCase();
        const raw = pair.slice(at + 1);
        if (at < 1 || name === "" || raw.trim() === "")
            return { error: BAD_EMAIL };
        if (emails.has(name))
            return { error: `\`${name}\` has more than one email. Give each person one.` };
        try {
            emails.set(name, memberEmail(raw, name));
        }
        catch (error) {
            if (error instanceof MemberError)
                return { error: error.message };
            throw error;
        }
    }
    return { emails };
}
/**
 * New members go after the existing ones, which are copied exactly as written:
 * `config patch` replaces whole arrays, so leaving one out would delete it.
 * A Discord ID changes only that person's `discordId`. An email changes only that person's `email`.
 * The patch copies every stored field, including an email, because leaving one out would delete it.
 */
function locate(members, token) {
    const hits = matchMemberIndexes(members, token);
    if (hits.length > 1)
        return { error: AMBIGUOUS_REFERENCE(token) };
    const index = hits[0];
    return index === undefined ? undefined : { index };
}
function membersPatch(existing, list, ids, emails, calendars, channels) {
    const skipped = [];
    const added = [];
    for (const person of list) {
        const found = locate(existing, person.name);
        if (found && "error" in found)
            return { skipped, error: found.error };
        if (found) {
            skipped.push(`${person.name} is already set up, so that entry was left as it is.`);
            continue;
        }
        const parts = memberParts(person.name);
        added.push({
            id: parts.id,
            profileId: person.name,
            displayName: parts.displayName,
            role: person.role,
            ...(ids.has(person.name) ? { discordId: ids.get(person.name) } : {}),
            ...(emails.has(person.name) ? { email: emails.get(person.name) } : {}),
        });
    }
    const working = [...existing, ...added];
    let changed = added.length;
    const apply = (token, write) => {
        const found = locate(working, token);
        if (found === undefined)
            return { error: `\`${token}\` isn't in the family yet. Add them with \`--parent\`, \`--kid\` or \`--guest\` in the same command.` };
        if ("error" in found)
            return found;
        const current = record(working[found.index]);
        const next = { ...current };
        let local = false;
        // Editing a legacy member must freeze the id it already uses; otherwise a
        // later name or login change moves calendar owners and reminder history.
        if (typeof next.id !== "string" || next.id.trim() === "") {
            try {
                next.id = readMemberIdentity(next, "members").id;
                local = true;
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        }
        if (write(next))
            local = true;
        if (!local)
            return undefined;
        changed += 1;
        working[found.index] = next;
        return undefined;
    };
    for (const [token, discordId] of ids) {
        const result = apply(token, (next) => {
            if (next.discordId === discordId)
                return false;
            next.discordId = discordId;
            return true;
        });
        if (result?.error)
            return { skipped, error: result.error };
    }
    for (const [token, email] of emails) {
        const result = apply(token, (next) => {
            if (next.email === email)
                return false;
            next.email = email;
            return true;
        });
        if (result?.error)
            return { skipped, error: result.error };
    }
    // parseConfig refuses a shared id, so catch it here instead of in the patch.
    const owners = new Map();
    for (const member of working) {
        const id = record(member).discordId;
        if (typeof id !== "string")
            continue;
        const owner = owners.get(id);
        if (owner)
            return { skipped, error: `${owner} and ${profileId(member)} have the same Discord ID. Each person needs their own.` };
        owners.set(id, profileId(member));
    }
    try {
        parseConfig({ members: working, calendars, channels });
    }
    catch (error) {
        return { skipped, error: error instanceof Error ? error.message : String(error) };
    }
    if (changed === 0)
        return { skipped };
    const patch = { plugins: { entries: { "oc-family-pack": { config: { members: working } } } } };
    return { skipped, patch: JSON.stringify(patch, null, 2) };
}
/** The Discord account the family uses: the only one configured, or OpenClaw's default. */
function discordAccount(host) {
    const configured = familyConfig(host).discordAccount;
    if (typeof configured === "string" && configured.trim() !== "")
        return configured.trim();
    const accounts = Object.keys(record(record(record(record(host).channels).discord).accounts));
    if (accounts.length > 1)
        return "ACCOUNT";
    return accounts[0] ?? "default";
}
/** `users.linkChannelIdentity` params for one person. The smoke sends exactly these. */
export function discordLink(profile, accountId, senderId) {
    return { profileId: profile, identity: { channelId: "discord", accountId, senderId } };
}
/** The parent Discord DMs a LAN household needs for plugin approvals. */
function expectedApprovalTargets(host, ids, extra = []) {
    const members = familyConfig(host).members;
    const account = discordAccount(host);
    const target = (id) => id === undefined
        ? []
        : [{ channel: "discord", to: `user:${id}`, ...(account !== "ACCOUNT" && account !== "default" ? { accountId: account } : {}) }];
    const targets = [
        ...(Array.isArray(members) ? members : []).flatMap((member) => {
            const entry = record(member);
            if (rosterRole(member) !== "parent")
                return [];
            const id = typeof entry.discordId === "string"
                ? entry.discordId
                : ids.get(profileId(member)) ?? ids.get(referenceOf(member));
            return target(id);
        }),
        ...extra.flatMap((person) => (person.role === "parent" ? target(ids.get(person.name)) : [])),
    ];
    const unique = new Map();
    for (const target of targets)
        unique.set(`${target.to}\u0000${target.accountId ?? ""}`, target);
    return [...unique.values()];
}
function approvalTargetMatches(expected, actual) {
    if (typeof actual.channel !== "string" || actual.channel.toLowerCase() !== expected.channel)
        return false;
    if (actual.to !== expected.to)
        return false;
    const account = typeof actual.accountId === "string" && actual.accountId !== "" ? actual.accountId : undefined;
    return expected.accountId === undefined ? account === undefined || account === "default" : account === expected.accountId;
}
function approvalsApplied(host, expected) {
    const plugin = record(record(record(host).approvals).plugin);
    if (plugin.enabled !== true || (plugin.mode !== "targets" && plugin.mode !== "both"))
        return false;
    const actual = Array.isArray(plugin.targets) ? plugin.targets : [];
    return expected.every((target) => actual.some((entry) => approvalTargetMatches(target, record(entry))));
}
/**
 * Parent Discord targets for plugin approvals. A parent needs
 * operator.approvals (the LAN role block grants it) and a delivery target.
 */
function approvalLines(host, ids, extra = []) {
    if (detectAccess(record(host).gateway).mode !== "lan")
        return [];
    const targets = expectedApprovalTargets(host, ids, extra);
    if (targets.length === 0 || approvalsApplied(host, targets))
        return [];
    return [
        "",
        "Gateway plugin approvals:",
        "A parent needs `operator.approvals` and a Discord target to approve a kid's shared-calendar change (this block also covers other plugin approvals). Add this to the Gateway config:",
        JSON.stringify({ approvals: { plugin: { enabled: true, mode: "targets", targets } } }, null, 2),
    ];
}
function linkLines(host, ids) {
    if (ids.size === 0 || detectAccess(record(host).gateway).mode !== "lan")
        return [];
    const account = discordAccount(host);
    return [
        "",
        LINK_INTRO,
        "Run this after they've signed in once, so their profile exists.",
        ...[...ids].map(([name, id]) => `openclaw gateway call users.linkChannelIdentity --params '${JSON.stringify(discordLink(`PROFILE_${name}`, account, id))}'`),
        PROFILE_STEP,
        ...(account === "ACCOUNT" ? ["Replace ACCOUNT with the `channels.discord.accounts` entry the family uses."] : []),
    ];
}
/** Members without a Discord ID, as the optional command that adds them. */
function discordHint(host) {
    const members = familyConfig(host).members;
    const missing = (Array.isArray(members) ? members : []).filter((member) => record(member).discordId === undefined).map(referenceOf);
    if (missing.length === 0)
        return [];
    return ["", `\`openclaw family setup --discord ${missing.map((name) => `${name}=DISCORD_ID_${name}`).join(" ")}\``, DISCORD_HELP];
}
/** `openclaw family setup`: a Done or To do line per part, then the one next step. */
export function planSetup(host, input, gog, hostZone) {
    try {
        parseConfig(familyConfig(host));
    }
    catch (error) {
        const message = error instanceof ConfigError || error instanceof MemberError ? error.message : error instanceof Error ? error.message : String(error);
        return { ok: false, text: `The family config needs fixing before setup can report it ready:\n${message}` };
    }
    const list = setupSteps(host, gog, hostZone);
    const checklist = list.map((step) => `${step.name}: ${step.done ? "Done" : "To do"}`);
    if (input.materializeIds) {
        const namedPeople = (input.parent ?? []).length + (input.kid ?? []).length + (input.guest ?? []).length > 0;
        if (namedPeople || (input.discord ?? []).length > 0 || (input.email ?? []).length > 0 || input.agent !== undefined) {
            return { ok: false, text: "Run `--materialize-ids` on its own." };
        }
        const config = familyConfig(host);
        const existing = Array.isArray(config.members) ? config.members : [];
        const calendars = Array.isArray(config.calendars) ? config.calendars : [];
        const preview = planMaterialize(existing, calendars);
        if (!preview.ok)
            return { ok: false, text: preview.error };
        if (!preview.changed)
            return { ok: true, text: "Every member and device already has an id. No changes to make." };
        return { ok: false, text: [MATERIALIZE_INTRO, "", PATCH_INTRO, `${preview.patch}\n`].join("\n") };
    }
    const rawAgent = input.agent !== undefined ? input.agent.trim().toLowerCase() : undefined;
    if (rawAgent !== undefined) {
        const agents = hostAgents(host);
        if (rawAgent === "" || (agents.ids.length > 0 && !agents.ids.includes(rawAgent))) {
            return { ok: false, text: `\`${input.agent?.trim() ?? ""}\` is not one of the configured agents (${agents.ids.join(", ")}).` };
        }
    }
    const named = (input.parent ?? []).length + (input.kid ?? []).length + (input.guest ?? []).length > 0;
    const asked = named || (input.discord ?? []).length > 0 || (input.email ?? []).length > 0 || rawAgent !== undefined;
    if (asked) {
        const found = named ? people(input) : { list: [] };
        if ("error" in found)
            return { ok: false, text: found.error };
        const parsed = discordIds(input.discord ?? []);
        if ("error" in parsed)
            return { ok: false, text: parsed.error };
        const mail = emailsOf(input.email ?? []);
        if ("error" in mail)
            return { ok: false, text: mail.error };
        const config = familyConfig(host);
        const existing = config.members;
        const calendars = Array.isArray(config.calendars) ? config.calendars : [];
        const { skipped, patch, error } = membersPatch(Array.isArray(existing) ? existing : [], found.list, parsed.ids, mail.emails, calendars, config.channels);
        if (error)
            return { ok: false, text: error };
        const agentChanged = rawAgent !== undefined && config.agentId !== rawAgent;
        const mergedPatch = patch !== undefined && agentChanged
            ? JSON.stringify({
                plugins: {
                    entries: {
                        "oc-family-pack": {
                            config: {
                                ...JSON.parse(patch).plugins.entries["oc-family-pack"].config,
                                agentId: rawAgent,
                            },
                        },
                    },
                },
            }, null, 2)
            : patch !== undefined
                ? patch
                : agentChanged
                    ? JSON.stringify({ plugins: { entries: { "oc-family-pack": { config: { agentId: rawAgent } } } } }, null, 2)
                    : undefined;
        if (mergedPatch) {
            return {
                ok: false,
                text: [...skipped, PATCH_INTRO, mergedPatch, ...linkLines(host, parsed.ids), ...approvalLines(host, parsed.ids, found.list), "", ...checklist].join("\n"),
            };
        }
        checklist.unshift(...skipped, "No changes to make.", "");
    }
    const optional = asked ? [] : discordHint(host);
    const next = list.find((step) => !step.done && step.optional !== true);
    const derived = derivedIds(host);
    const quiet = quietMorningBrief(host);
    const warnings = [...derived, ...unreachable(host), ...quiet];
    const warned = warnings.length > 0 ? ["", ...warnings] : [];
    const approvals = approvalLines(host, new Map());
    if (!next) {
        const pendingApproval = approvals.length > 0;
        const unset = list.filter((step) => step.optional === true && !step.done);
        const optionalLeft = unset.length > 0 && !pendingApproval && derived.length === 0
            ? ["", "Optional pieces still unset. `openclaw family setup --guide` asks each one. skip leaves it off.", ...unset.flatMap((step) => ["", step.name, step.next])]
            : [];
        return {
            ok: !pendingApproval && derived.length === 0,
            text: [
                ...checklist,
                ...warned,
                ...optional,
                ...approvals,
                ...optionalLeft,
                "",
                pendingApproval
                    ? "The config is complete. Apply the approval block, then run the pilot preflight."
                    : derived.length > 0
                        ? "The checklist is complete. Run `openclaw family setup --materialize-ids`, apply its patch, then run the pilot preflight."
                        : quiet.length > 0
                            ? "The checklist is complete. The morning brief stays quiet until a parent sets `reminders`."
                            : "Everything is set up.",
            ].join("\n"),
        };
    }
    return { ok: false, text: [...checklist, ...warned, ...optional, ...approvals, "", `Next: ${next.next}`].join("\n") };
}
