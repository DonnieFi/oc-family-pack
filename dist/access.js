// Household access: detect which sign-in mode the Gateway is in and print the
// setup for a mode. Pure: no imports, no files, no Gateway calls, no config
// writes. Secrets in the config are checked for presence and never printed.
export const ROLES = ["parent", "kid", "guest"];
export const SCOPES = {
    parent: ["operator.read", "operator.write", "operator.sessions.write"],
    kid: ["operator.read", "operator.sessions.write"],
    guest: ["operator.read"],
};
const SESSIONS = { parent: "write", kid: "none", guest: "none" };
const USERNAME = /^[a-z0-9._-]{1,32}$/;
const LAN_HEADER = "x-forwarded-user";
const DEFAULT_PORT = 18789;
const MODE_LINE = {
    solo: "Solo. Everyone who opens the Control UI is the owner. Family members use Discord, where the bot knows who's talking.",
    lan: "LAN. Each person signs in to Caddy with their own username and password. The Gateway knows who they are, and their role decides what they can do.",
};
const MODE_NAME = { solo: "solo", lan: "LAN" };
const PROXY_LINE = "LAN mode needs a proxy on this machine that serves HTTPS and signs each person in. The example below uses Caddy (https://caddyserver.com/docs/install).";
const HTTPS_INTERNAL = "This uses Caddy's own certificate. Install Caddy's root certificate once on every family phone and laptop, or the Family page won't load. It's `pki/authorities/local/root.crt` in Caddy's data folder. Nothing on this machine has to be reachable from the internet.";
const PROXY_RULES = "Any proxy works if it's the only way to reach the Gateway, signs each person in, sends their username in `X-Forwarded-User`, and replaces any `X-Forwarded-User` or `X-Forwarded-For` the browser sends.";
const NO_SIGN_OUT = "There's no sign-out and no way to switch accounts. A browser stays signed in as whoever used it first, until you clear its saved data for this site. On a shared laptop, give each person their own browser profile. If you want a sign-in page, sign-out or passkeys, upgrade to Authelia.";
const LOOPBACK_WARNING = "Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.";
const LAN_ADDRESS_STEP = "Replace `LAN_ADDRESS` with this machine's address on your home network, like `192.168.1.20`. Use the same address in the Caddyfile and in `allowedOrigins`. If you add a port to the Caddyfile, add it to the origin too.";
const OUTSIDE = "This Gateway lets people sign in from outside your home network. Family Pack is local only, so it doesn't set that up. Use `openclaw family access lan` instead.";
const HASH_STEP = "Run `caddy hash-password` once for each person and paste each hash in place of its placeholder.";
const ROLES_INTRO = "Everyone starts as a guest who can only read. The role caps what someone can do, and `identityScopes` grants it. This block sets both.";
const TOKEN_NOTE = "The shared Gateway token stops working in LAN mode. Keep the Gateway password, because `users.setRole` uses it.";
const SET_ROLE_INTRO = "After each person signs in once, set their role:";
export const PROFILE_STEP = "Replace each PROFILE_ placeholder with that person's profile id from `users.list`.";
const BAD_USERNAME = "Usernames use lower-case letters, numbers, dots, dashes or underscores. Try `alex`, not `Alex Smith`.\nEach person sees their username as their name in the Control UI, so use what the family calls them.";
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function present(value) {
    return (typeof value === "string" && value.length > 0) || Object.keys(record(value)).length > 0;
}
/**
 * True when the Gateway already lets people in from outside the home network.
 * Family Pack is local only, so every mode stops here. The only place the
 * outside services are named.
 */
export function outsideSignIn(gateway) {
    const g = record(gateway);
    const auth = record(g.auth);
    const proxy = record(auth.trustedProxy);
    const tailscale = record(g.tailscale).mode;
    return (tailscale === "serve" ||
        tailscale === "funnel" ||
        auth.allowTailscale === true ||
        present(proxy.cloudflareAccessOidc) ||
        proxy.userHeader === "cf-access-authenticated-user-email");
}
/** Which local mode the Gateway is in, and each step still missing for it. */
/** `https://host` or `https://host:port`: no wildcard, no path, no query, no credentials. */
const BARE_HTTPS = /^https:\/\/[^/\s*?#@]+$/;
export function detectAccess(gateway) {
    const g = record(gateway);
    const auth = record(g.auth);
    const proxy = record(auth.trustedProxy);
    const loopback = g.bind === undefined || g.bind === "loopback";
    const missing = [];
    if (record(record(g.controlUi).experimental).customPlugins !== true) {
        missing.push("Set `gateway.controlUi.experimental.customPlugins` to `true`, so the Family page can load.");
    }
    const needLoopback = "Set `gateway.bind` to `loopback`.";
    if (auth.mode === "trusted-proxy") {
        if (proxy.userHeader !== LAN_HEADER)
            missing.push(`Set \`gateway.auth.trustedProxy.userHeader\` to \`${LAN_HEADER}\`.`);
        if (!Array.isArray(proxy.allowUsers) || proxy.allowUsers.length === 0) {
            missing.push("List the family usernames in `gateway.auth.trustedProxy.allowUsers`.");
        }
        if (proxy.allowLoopback !== true)
            missing.push("Set `gateway.auth.trustedProxy.allowLoopback` to `true`, because the proxy runs on this machine.");
        // publicOrigin alone doesn't count: it describes a Gateway reachable from outside.
        const origins = record(g.controlUi).allowedOrigins;
        if (!Array.isArray(origins) || origins.length === 0 || !origins.every((origin) => typeof origin === "string" && BARE_HTTPS.test(origin))) {
            missing.push("Set `gateway.controlUi.allowedOrigins` to the one address the family opens, like `https://192.168.1.20`. It has to start with `https://`, with no `*` and no path.");
        }
        // Exactly loopback: any wider entry lets another LAN machine pose as the proxy.
        if (!Array.isArray(g.trustedProxies) || g.trustedProxies.length !== 1 || g.trustedProxies[0] !== "127.0.0.1") {
            missing.push("Set `gateway.trustedProxies` to only `127.0.0.1`, so nothing else on your network can pretend to be the proxy.");
        }
        if (!loopback)
            missing.push(`${needLoopback} The proxy should be the only way in.`);
        if (!present(auth.password))
            missing.push("Set a `gateway.auth.password`, because `users.setRole` uses it.");
        return { mode: "lan", missing };
    }
    if (!loopback)
        missing.push(`${needLoopback} Native pages need HTTPS or loopback.`);
    return { mode: "solo", missing };
}
export function formatDetection(found) {
    const name = MODE_NAME[found.mode];
    const count = found.missing.length;
    const lines = [
        count === 0
            ? `This Gateway is in ${name} mode and is set up.`
            : `This Gateway is in ${name} mode. ${count} ${count === 1 ? "step" : "steps"} left:`,
        ...found.missing.map((step) => `- ${step}`),
    ];
    // Detection can't see what else listens on loopback, so this shows even when complete.
    if (found.mode === "lan")
        lines.push(LOOPBACK_WARNING);
    if (found.mode === "lan")
        lines.push("Roles are set per person with `users.setRole`, so they can't be checked from here.");
    lines.push(`Next: openclaw family access ${found.mode}${found.mode === "solo" ? "" : " --parent NAME"}`);
    return { ok: count === 0, text: lines.join("\n") };
}
/** The username rule `access` and `setup` share, so the roster and `allowUsers` can't drift apart. */
export function people(input) {
    const list = [];
    const seen = new Set();
    const entries = [
        ...ROLES.flatMap((role) => (input[role] ?? []).map((name) => [name, role])),
        ...(input.names ?? []).map((name) => [name, "guest"]),
    ];
    for (const [name, role] of entries) {
        if (!USERNAME.test(name))
            return { error: BAD_USERNAME };
        if (seen.has(name))
            return { error: `\`${name}\` is listed more than once. Give each person one role.` };
        seen.add(name);
        list.push({ name, role });
    }
    if (list.length === 0)
        return { error: "Name at least one person, for example `--parent alex`." };
    return { list: list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}
function json(value) {
    return JSON.stringify(value, null, 2);
}
function rolesBlock(list) {
    return json({
        gateway: {
            auth: { identityScopes: Object.fromEntries(list.map((person) => [person.name, SCOPES[person.role]])) },
            roles: {
                default: "guest",
                definitions: Object.fromEntries(ROLES.map((role) => [role, { sessions: { others: SESSIONS[role] }, agents: "*", scopes: SCOPES[role] }])),
            },
        },
    });
}
function setRoleLines(list) {
    return [
        SET_ROLE_INTRO,
        "openclaw gateway call users.list --json",
        ...list.map((person) => `openclaw gateway call users.setRole --params '{"profileId":"PROFILE_${person.name}","role":"${person.role}"}'`),
        PROFILE_STEP,
    ];
}
const CUSTOM_PLUGINS = { experimental: { customPlugins: true } };
const SITE = "LAN_ADDRESS";
function caddyfile(list, port) {
    return [
        `${SITE} {`,
        "\ttls internal",
        "\tbasic_auth {",
        ...list.map((person) => `\t\t${person.name} HASH_${person.name}`),
        "\t}",
        `\treverse_proxy 127.0.0.1:${port} {`,
        "\t\theader_up X-Forwarded-User {http.auth.user.id}",
        "\t\theader_up X-Forwarded-For {remote_host}",
        "\t}",
        "}",
    ].join("\n");
}
/** The setup for one mode. Prints only; nothing here stores or accepts a password. */
export function planAccess(mode, input, opts) {
    if (mode === "solo") {
        const named = ROLES.some((role) => (input[role] ?? []).length > 0) || (input.names ?? []).length > 0;
        return {
            ok: true,
            text: [
                MODE_LINE.solo,
                ...(named ? ["Solo has no per-person sign-in, so the names were left out."] : []),
                "",
                "Gateway config:",
                json({ gateway: { bind: "loopback", controlUi: CUSTOM_PLUGINS } }),
            ].join("\n"),
        };
    }
    if (mode === "lan") {
        const found = people(input);
        if ("error" in found)
            return { ok: false, text: found.error };
        const list = found.list;
        return {
            ok: true,
            text: [
                MODE_LINE.lan,
                PROXY_LINE,
                HTTPS_INTERNAL,
                LOOPBACK_WARNING,
                NO_SIGN_OUT,
                "",
                PROXY_RULES,
                "Caddyfile:",
                caddyfile(list, opts.port ?? DEFAULT_PORT),
                LAN_ADDRESS_STEP,
                HASH_STEP,
                "",
                "Gateway config:",
                json({
                    gateway: {
                        bind: "loopback",
                        controlUi: { ...CUSTOM_PLUGINS, allowedOrigins: [`https://${SITE}`] },
                        trustedProxies: ["127.0.0.1"],
                        auth: {
                            mode: "trusted-proxy",
                            trustedProxy: { userHeader: LAN_HEADER, allowUsers: list.map((person) => person.name), allowLoopback: true },
                        },
                    },
                }),
                "",
                ROLES_INTRO,
                TOKEN_NOTE,
                "Roles:",
                rolesBlock(list),
                "",
                ...setRoleLines(list),
            ].join("\n"),
        };
    }
    return { ok: false, text: "Pick a mode: `solo` or `lan`." };
}
/** `openclaw family access [mode]`: report with no mode, otherwise print that mode's setup. */
export function runAccess(gateway, mode, input, opts) {
    if (outsideSignIn(gateway))
        return { ok: false, text: OUTSIDE };
    return mode === undefined ? formatDetection(detectAccess(gateway)) : planAccess(mode, input, opts);
}
