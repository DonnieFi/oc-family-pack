// Household access: detect which sign-in mode the Gateway is in and print the
// setup for a mode. Pure: no imports, no files, no Gateway calls, no config
// writes. Secrets in the config are checked for presence and never printed.

export type AccessMode = "solo" | "lan";
export type AccessDetection = { mode: AccessMode; missing: string[] };
export type AccessPeople = { parent?: string[]; kid?: string[]; guest?: string[]; names?: string[] };
export type AccessResult = { ok: boolean; text: string };
export type GatewayUserProfile = { id: string; displayName?: string; emails?: string[]; role?: string };
export type AccessOptions = {
  port?: number;
  members?: unknown[];
  profiles?: GatewayUserProfile[];
};

export const ROLES = ["parent", "kid", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES: Record<Role, string[]> = {
  // operator.approvals lets a parent resolve the calendar approval the plugin
  // asks for; it is not granted to kids or guests.
  parent: ["operator.read", "operator.write", "operator.sessions.write", "operator.approvals"],
  kid: ["operator.read", "operator.sessions.write"],
  guest: ["operator.read"],
};
const SESSIONS: Record<Role, "write" | "none"> = { parent: "write", kid: "none", guest: "none" };

const USERNAME = /^(?:[a-z0-9._-]{1,32}|[a-z0-9.+_-]+@[a-z0-9.-]+\.[a-z]{2,})$/;
const LAN_HEADER = "x-forwarded-user";
const DEFAULT_PORT = 18789;

const MODE_LINE: Record<AccessMode, string> = {
  solo: "Solo. Everyone who opens the Control UI is the owner. Family members use Discord, where the bot knows who's talking.",
  lan: "LAN. Each person signs in to Caddy with their own username and password. The Gateway knows who they are, and their role decides what they can do.",
};
const MODE_NAME: Record<AccessMode, string> = { solo: "solo", lan: "LAN" };

const PROXY_LINE =
  "LAN mode needs a proxy on this machine that serves HTTPS and signs each person in. The example below uses Caddy (https://caddyserver.com/docs/install).";
const HTTPS_INTERNAL =
  "This uses Caddy's own certificate. Install Caddy's root certificate once on every family phone and laptop, or the Family page won't load. It's `pki/authorities/local/root.crt` in Caddy's data folder. Nothing on this machine has to be reachable from the internet.";
const PROXY_RULES =
  "Any proxy works if it's the only way to reach the Gateway, signs each person in, sends their username in `X-Forwarded-User`, and replaces any `X-Forwarded-User` or `X-Forwarded-For` the browser sends.";
const NO_SIGN_OUT =
  "There's no sign-out and no way to switch accounts. A browser stays signed in as whoever used it first, until you clear its saved data for this site. On a shared laptop, give each person their own browser profile. A paired device token is the shared owner in solo mode. In LAN mode, a device token with no device identity is refused by the Gateway before the plugin runs. A paired token can connect, but the plugin has no household username for it, so it reads as a guest and sees shared calendars only; don't leave one on a kid's device. If you want a sign-in page, sign-out or passkeys, upgrade to Authelia.";
const LOOPBACK_WARNING = "Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.";
const LAN_ADDRESS_STEP = "Replace `LAN_ADDRESS` with this machine's address on your home network, like `192.168.1.20`. Use the same address in the Caddyfile and in `allowedOrigins`. If you add a port to the Caddyfile, add it to the origin too.";
const OUTSIDE =
  "This Gateway lets people sign in from outside your home network. Family Pack is local only, so it doesn't set that up. Use `openclaw family access lan` instead.";
const HASH_STEP = "Run `caddy hash-password` once for each person and paste each hash in place of its placeholder.";
const ROLES_INTRO = "Everyone starts as a guest who can only read. The role caps what someone can do, and `identityScopes` grants it. This block sets both.";
const TOKEN_NOTE = "The shared Gateway token stops working in LAN mode. Keep the Gateway password, because `users.setRole` uses it.";
const SET_ROLE_INTRO = "After each person signs in once, set their role:";
export const PROFILE_STEP = "Replace each PROFILE_ placeholder with that person's profile id from `users.list`.";
const BAD_USERNAME =
  "Usernames use lower-case letters, numbers, dots, dashes, underscores, or a plain email address. Try `alex` or `alex@example.com`, not `Alex Smith`.\nEach person sees this as their name in the Control UI, so use what the family calls them. It must match the `X-Forwarded-User` value your proxy sends.";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function present(value: unknown): boolean {
  return (typeof value === "string" && value.length > 0) || Object.keys(record(value)).length > 0;
}

/**
 * True when the Gateway already lets people in from outside the home network.
 * Family Pack is local only, so every mode stops here. The only place the
 * outside services are named.
 */
export function outsideSignIn(gateway: unknown): boolean {
  const g = record(gateway);
  const auth = record(g.auth);
  const proxy = record(auth.trustedProxy);
  const tailscale = record(g.tailscale).mode;
  return (
    tailscale === "serve" ||
    tailscale === "funnel" ||
    auth.allowTailscale === true ||
    present(proxy.cloudflareAccessOidc) ||
    proxy.userHeader === "cf-access-authenticated-user-email"
  );
}

/**
 * The plugin's effective page-identity policy. An explicit setting wins.
 * Otherwise a Gateway using trusted-proxy auth is LAN even before the plugin
 * config names it, so a paired device token cannot become the shared owner.
 */
export function accessModeFor(gateway: unknown, configured?: AccessMode): AccessMode | undefined {
  if (configured !== undefined) return configured;
  return detectAccess(gateway).mode === "lan" ? "lan" : undefined;
}

/** Which local mode the Gateway is in, and each step still missing for it. */
/** `https://host` or `https://host:port`: no wildcard, no path, no query, no credentials. */
const BARE_HTTPS = /^https:\/\/[^/\s*?#@]+$/;

export function detectAccess(gateway: unknown): AccessDetection {
  const g = record(gateway);
  const auth = record(g.auth);
  const proxy = record(auth.trustedProxy);
  const loopback = g.bind === undefined || g.bind === "loopback";
  const missing: string[] = [];
  if (record(record(g.controlUi).experimental).customPlugins !== true) {
    missing.push("Set `gateway.controlUi.experimental.customPlugins` to `true`, so the Family page can load.");
  }
  const needLoopback = "Set `gateway.bind` to `loopback`.";

  if (auth.mode === "trusted-proxy") {
    if (proxy.userHeader !== LAN_HEADER) missing.push(`Set \`gateway.auth.trustedProxy.userHeader\` to \`${LAN_HEADER}\`.`);
    if (!Array.isArray(proxy.allowUsers) || proxy.allowUsers.length === 0) {
      missing.push("List the family usernames in `gateway.auth.trustedProxy.allowUsers`.");
    }
    if (proxy.allowLoopback !== true) missing.push("Set `gateway.auth.trustedProxy.allowLoopback` to `true`, because the proxy runs on this machine.");
    // publicOrigin alone doesn't count: it describes a Gateway reachable from outside.
    const origins = record(g.controlUi).allowedOrigins;
    if (!Array.isArray(origins) || origins.length === 0 || !origins.every((origin) => typeof origin === "string" && BARE_HTTPS.test(origin))) {
      missing.push("Set `gateway.controlUi.allowedOrigins` to the one address the family opens, like `https://192.168.1.20`. It has to start with `https://`, with no `*` and no path.");
    }
    // Exactly loopback: any wider entry lets another LAN machine pose as the proxy.
    if (!Array.isArray(g.trustedProxies) || g.trustedProxies.length !== 1 || g.trustedProxies[0] !== "127.0.0.1") {
      missing.push("Set `gateway.trustedProxies` to only `127.0.0.1`, so nothing else on your network can pretend to be the proxy.");
    }
    if (!loopback) missing.push(`${needLoopback} The proxy should be the only way in.`);
    if (!present(auth.password)) missing.push("Set a `gateway.auth.password`, because `users.setRole` uses it.");
    return { mode: "lan", missing };
  }
  if (!loopback) missing.push(`${needLoopback} Native pages need HTTPS or loopback.`);
  return { mode: "solo", missing };
}

export function formatDetection(found: AccessDetection): AccessResult {
  const name = MODE_NAME[found.mode];
  const count = found.missing.length;
  const lines = [
    count === 0
      ? `This Gateway is in ${name} mode and is set up.`
      : `This Gateway is in ${name} mode. ${count} ${count === 1 ? "step" : "steps"} left:`,
    ...found.missing.map((step) => `- ${step}`),
  ];
  // Detection can't see what else listens on loopback, so this shows even when complete.
  if (found.mode === "lan") lines.push(LOOPBACK_WARNING);
  if (found.mode === "lan") lines.push("Roles are set per person with `users.setRole`, so they can't be checked from here.");
  lines.push(`Next: openclaw family access ${found.mode}${found.mode === "solo" ? "" : " --parent NAME"}`);
  return { ok: count === 0, text: lines.join("\n") };
}

export type Person = { name: string; role: Role };

/** The username rule `access` and `setup` share, so the roster and `allowUsers` can't drift apart. */
export function people(input: AccessPeople): { list: Person[] } | { error: string } {
  const list: Person[] = [];
  const seen = new Set<string>();
  const entries: [string, Role][] = [
    ...ROLES.flatMap((role) => (input[role] ?? []).map((name): [string, Role] => [name, role])),
    ...(input.names ?? []).map((name): [string, Role] => [name, "guest"]),
  ];
  for (const [name, role] of entries) {
    if (!USERNAME.test(name)) return { error: BAD_USERNAME };
    if (seen.has(name)) return { error: `\`${name}\` is listed more than once. Give each person one role.` };
    seen.add(name);
    list.push({ name, role });
  }
  if (list.length === 0) return { error: "Name at least one person, for example `--parent alex`." };
  return { list: list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function rolesBlock(list: Person[]): string {
  return json({
    gateway: {
      auth: { identityScopes: Object.fromEntries(list.map((person) => [person.name, SCOPES[person.role]])) },
      roles: {
        default: "guest",
        definitions: Object.fromEntries(
          ROLES.map((role) => [role, { sessions: { others: SESSIONS[role] }, agents: "*", scopes: SCOPES[role] }]),
        ),
      },
    },
  });
}

function setRoleLines(list: Person[]): string[] {
  return [
    SET_ROLE_INTRO,
    "openclaw gateway call users.list --json",
    ...list.map((person) => `openclaw gateway call users.setRole --params '{"profileId":"PROFILE_${person.name}","role":"${person.role}"}'`),
    PROFILE_STEP,
  ];
}

const CUSTOM_PLUGINS = { experimental: { customPlugins: true } };

const SITE = "LAN_ADDRESS";

function caddyfile(list: Person[], port: number): string {
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
export function planAccess(
  mode: string | undefined,
  input: AccessPeople,
  opts: AccessOptions,
): AccessResult {
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
    if ("error" in found) return { ok: false, text: found.error };
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

function memberSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function memberLoginOf(member: unknown): string | undefined {
  const entry = record(member);
  for (const value of [entry.profileId, entry.login]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return undefined;
}

function memberNameOf(member: unknown): string {
  const entry = record(member);
  for (const value of [entry.name, entry.displayName, entry.id, entry.profileId, entry.login]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function memberIdOf(member: unknown): string {
  const entry = record(member);
  if (typeof entry.id === "string" && entry.id.trim() !== "") return entry.id.trim().toLowerCase();
  const login = memberLoginOf(member);
  if (login !== undefined) {
    if (!login.includes("@")) return memberSlug(login) || login;
    const rawName = typeof entry.name === "string" ? entry.name.trim() : typeof entry.displayName === "string" ? entry.displayName.trim() : "";
    if (rawName === "" || rawName.toLowerCase() === login) return login;
    const local = login.slice(0, login.indexOf("@"));
    return memberSlug(local) || login;
  }
  return memberSlug(memberNameOf(member));
}

function memberRoleOf(member: unknown): Role {
  const role = record(member).role;
  return typeof role === "string" && (ROLES as readonly string[]).includes(role) ? (role as Role) : "guest";
}

function scopeRoleOf(scopes: unknown): Role {
  const given = Array.isArray(scopes) ? scopes.map(String) : [];
  if (given.includes("operator.write") || given.includes("operator.admin")) return "parent";
  if (given.includes("operator.sessions.write")) return "kid";
  return "guest";
}

function matchMemberIndex(members: readonly unknown[], token: string): { index: number } | { error: string } | undefined {
  const needle = token.trim().toLowerCase();
  const hits: number[] = [];
  members.forEach((member, index) => {
    const entry = record(member);
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((a) => String(a).trim().toLowerCase()) : [];
    const candidates = [
      memberIdOf(member),
      memberLoginOf(member),
      typeof entry.name === "string" ? entry.name.trim().toLowerCase() : undefined,
      typeof entry.displayName === "string" ? entry.displayName.trim().toLowerCase() : undefined,
      ...aliases,
    ].filter((v): v is string => v !== undefined && v !== "");
    if (candidates.includes(needle)) hits.push(index);
  });
  if (hits.length > 1) return { error: `More than one family member matches \`${token}\`. Use their member id instead.` };
  return hits[0] === undefined ? undefined : { index: hits[0] };
}

function matchGatewayProfile(member: unknown, login: string, profiles: readonly GatewayUserProfile[] | undefined): GatewayUserProfile | undefined {
  const entry = record(member);
  const pinned = typeof entry.gatewayProfileId === "string" && entry.gatewayProfileId.trim() !== "" ? entry.gatewayProfileId.trim() : undefined;
  if (!profiles) return pinned ? { id: pinned } : undefined;
  if (pinned) {
    const byId = profiles.find((profile) => profile.id === pinned);
    if (byId) return byId;
  }
  const matches = profiles.filter((profile) => {
    const display = profile.displayName?.trim().toLowerCase();
    const email = profile.emails?.[0]?.trim().toLowerCase();
    return display === login || email === login;
  });
  return matches.length === 1 ? matches[0] : pinned ? { id: pinned } : undefined;
}

/**
 * `openclaw family access role NAME=ROLE ...`: print the `identityScopes` block,
 * the `users.setRole` call (with the real profile id from `users.list` when
 * available), and the `members[].role` config patch together.
 */
export function planAccessRole(
  gateway: unknown,
  input: AccessPeople,
  opts: AccessOptions = {},
): AccessResult {
  const entries: [string, Role][] = [
    ...ROLES.flatMap((role) => (input[role] ?? []).map((name): [string, Role] => [name.trim().toLowerCase(), role])),
  ];
  for (const raw of input.names ?? []) {
    const at = raw.indexOf("=");
    const name = raw.slice(0, at).trim().toLowerCase();
    const role = raw.slice(at + 1).trim().toLowerCase();
    if (at < 1 || name === "" || !(ROLES as readonly string[]).includes(role)) {
      return {
        ok: false,
        text: "Pass each role change as `NAME=ROLE` (`parent`, `kid`, or `guest`), for example `openclaw family access role alex=parent`.",
      };
    }
    entries.push([name, role as Role]);
  }
  if (entries.length === 0) {
    return {
      ok: false,
      text: "Pass at least one `NAME=ROLE` pair, for example `openclaw family access role alex=parent`.",
    };
  }
  const seen = new Set<string>();
  const existingMembers = Array.isArray(opts.members) ? opts.members : [];
  const nextMembers = existingMembers.map((member) => ({ ...record(member) }));
  const resolved: { login: string; role: Role; profileId: string; placeholder: boolean }[] = [];

  for (const [token, role] of entries) {
    if (seen.has(token)) return { ok: false, text: `\`${token}\` is listed more than once. Give each person one role.` };
    seen.add(token);
    if (existingMembers.length > 0) {
      const found = matchMemberIndex(existingMembers, token);
      if (found === undefined) {
        return { ok: false, text: `\`${token}\` isn't in the family roster yet. Add them with \`openclaw family setup --${role} ${token}\` first.` };
      }
      if ("error" in found) return { ok: false, text: found.error };
      const target = nextMembers[found.index]!;
      const login = memberLoginOf(target);
      if (login === undefined) {
        return { ok: false, text: `${memberNameOf(target)} has no Control UI login. Add \`login\` to that member first.` };
      }
      if (typeof target.id !== "string" || target.id.trim() === "") target.id = memberIdOf(target);
      target.role = role;
      const profile = matchGatewayProfile(target, login, opts.profiles);
      resolved.push({
        login,
        role,
        profileId: profile?.id ?? `PROFILE_${login}`,
        placeholder: profile === undefined,
      });
    } else {
      if (!USERNAME.test(token)) return { ok: false, text: BAD_USERNAME };
      const profile = matchGatewayProfile({}, token, opts.profiles);
      const local = token.includes("@") ? token.slice(0, token.indexOf("@")) : token;
      const id = memberSlug(local) || token;
      const displayName = (local[0]?.toUpperCase() ?? "") + local.slice(1);
      nextMembers.push({ id, profileId: token, displayName, role });
      resolved.push({
        login: token,
        role,
        profileId: profile?.id ?? `PROFILE_${token}`,
        placeholder: profile === undefined,
      });
    }
  }

  const existingScopes = record(record(record(gateway).auth).identityScopes);
  const identityScopes: Record<string, unknown> = { ...existingScopes };
  for (const item of resolved) identityScopes[item.login] = SCOPES[item.role];

  const needPlaceholder = resolved.some((item) => item.placeholder);
  const setRoleCommands = [
    ...(needPlaceholder ? ["openclaw gateway call users.list --json"] : []),
    ...resolved.map((item) => `openclaw gateway call users.setRole --params '${JSON.stringify({ profileId: item.profileId, role: item.role })}'`),
    ...(needPlaceholder ? [PROFILE_STEP] : []),
  ];

  return {
    ok: true,
    text: [
      "Apply all three so Gateway sign-in scopes, the Gateway host role, and the Family Pack roster stay in sync:",
      "",
      "1. Gateway identityScopes:",
      json({ gateway: { auth: { identityScopes } } }),
      "",
      "2. Gateway role:",
      ...setRoleCommands,
      "",
      "3. Family roster:",
      json({ plugins: { entries: { "oc-family-pack": { config: { members: nextMembers } } } } }),
    ].join("\n"),
  };
}

/**
 * `openclaw family access check`: compare `members[].role`,
 * `gateway.auth.identityScopes`, and `users.list` profiles per person.
 */
export function formatAccessCheck(
  gateway: unknown,
  opts: AccessOptions = {},
): AccessResult {
  const members = Array.isArray(opts.members) ? opts.members : [];
  if (members.length === 0) {
    return { ok: false, text: "No family members are configured yet. Run `openclaw family setup --parent NAME` first." };
  }
  const scopes = record(record(record(gateway).auth).identityScopes);
  const lines: string[] = [];
  const fixes: string[] = [];
  let allOk = true;
  for (const member of members) {
    const name = memberNameOf(member);
    const roster = memberRoleOf(member);
    const login = memberLoginOf(member);
    if (login === undefined) {
      allOk = false;
      lines.push(`${name}: roster=${roster}, identityScopes=no login, Gateway role=no login (mismatch)`);
      continue;
    }
    const hasScopes = Array.isArray(scopes[login]);
    const scopeRole = hasScopes ? scopeRoleOf(scopes[login]) : "unset";
    const profile = matchGatewayProfile(member, login, opts.profiles);
    const hostRole =
      opts.profiles === undefined
        ? "unchecked"
        : profile === undefined
          ? "not signed in"
          : typeof profile.role === "string" && profile.role.trim() !== ""
            ? profile.role.trim()
            : "guest";
    const scopeOk = scopeRole === roster;
    const hostOk = opts.profiles === undefined || hostRole === "not signed in" || hostRole === roster;
    const ok = scopeOk && hostOk;
    if (!ok) {
      allOk = false;
      fixes.push(`${login}=${roster}`);
    }
    lines.push(`${name} (${login}): roster=${roster}, identityScopes=${scopeRole}, Gateway role=${hostRole} (${ok ? "ok" : "mismatch"})`);
  }
  if (fixes.length > 0) {
    lines.push("", `Run: openclaw family access role ${fixes.join(" ")}`);
  }
  return { ok: allOk, text: lines.join("\n") };
}

/** `openclaw family access [mode]`: report with no mode, otherwise print that mode's setup. */
export function runAccess(
  gateway: unknown,
  mode: string | undefined,
  input: AccessPeople,
  opts: AccessOptions,
): AccessResult {
  if (outsideSignIn(gateway)) return { ok: false, text: OUTSIDE };
  if (mode === "role") return planAccessRole(gateway, input, opts);
  if (mode === "check") return formatAccessCheck(gateway, opts);
  return mode === undefined ? formatDetection(detectAccess(gateway)) : planAccess(mode, input, opts);
}
