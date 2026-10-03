// Guided setup: what the Family page still needs, and the one next step.
// Pure: reads the host config it is given and prints a config patch. Nothing
// here writes config, stores a password, or calls the Gateway.
import { detectAccess, outsideSignIn, people, ROLES, SCOPES } from "./access.js";
import { WEATHER_SETUP_HINT } from "./weather-ec.js";
const CONFIG_PATH = "plugins.entries.oc-family-pack.config";
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
/**
 * New members go after the existing ones, which are copied exactly as written:
 * `config patch` replaces whole arrays, so leaving one out would delete it.
 */
function membersPatch(existing, list) {
    const taken = new Set(existing.map(profileId));
    const skipped = list.filter((person) => taken.has(person.name)).map((person) => `${person.name} is already set up, so that entry was left as it is.`);
    const added = list
        .filter((person) => !taken.has(person.name))
        .map((person) => ({ profileId: person.name, displayName: person.name[0]?.toUpperCase() + person.name.slice(1), role: person.role }));
    if (added.length === 0)
        return { skipped };
    const patch = { plugins: { entries: { "oc-family-pack": { config: { members: [...existing, ...added] } } } } };
    return { skipped, patch: JSON.stringify(patch, null, 2) };
}
/** `openclaw family setup`: a Done or To do line per part, then the one next step. */
export function planSetup(host, input, gog, hostZone) {
    const list = steps(host, gog, hostZone);
    const checklist = list.map((step) => `${step.name}: ${step.done ? "Done" : "To do"}`);
    const asked = (input.parent ?? []).length + (input.kid ?? []).length + (input.guest ?? []).length > 0;
    if (asked) {
        const found = people(input);
        if ("error" in found)
            return { ok: false, text: found.error };
        const existing = familyConfig(host).members;
        const { skipped, patch } = membersPatch(Array.isArray(existing) ? existing : [], found.list);
        if (patch) {
            return {
                ok: false,
                text: [
                    ...skipped,
                    PATCH_INTRO,
                    patch,
                    "",
                    ...checklist,
                ].join("\n"),
            };
        }
        checklist.unshift(...skipped, "No changes to make.", "");
    }
    const next = list.find((step) => !step.done);
    if (!next)
        return { ok: true, text: [...checklist, "", "Everything is set up."].join("\n") };
    return { ok: false, text: [...checklist, "", `Next: ${next.next}`].join("\n") };
}
