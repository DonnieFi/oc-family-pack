import assert from "node:assert/strict";
import { test } from "node:test";
import { planAccess } from "./access.ts";
import type { GogSetupPlan } from "./gog-setup.ts";
import { PATCH_INTRO, planSetup } from "./setup.ts";

const READY: GogSetupPlan = { status: "ready", command: "gog calendar calendars --json --no-input", message: "" };
const MISSING: GogSetupPlan = { status: "missing", command: "brew install openclaw/tap/gogcli", message: "" };
const SOLO = { bind: "loopback", controlUi: { experimental: { customPlugins: true } } };
const ALEX = {
  id: "alex",
  profileId: "alex",
  displayName: "Alex P.",
  role: "parent",
  color: "#3366ff",
  devices: [{ label: "Phone", primaryMac: "AA:BB:CC:DD:EE:01", source: "unifi" }],
};

function host(config: Record<string, unknown>, gateway: unknown = SOLO) {
  return { gateway, plugins: { entries: { "oc-family-pack": { enabled: true, config } } } };
}

const complete = {
  accessMode: "lan",
  timezone: "America/Halifax",
  location: { lat: 44.65, lon: -63.57 },
  members: [ALEX],
  calendars: [{ id: "family@group.calendar.google.com", label: "Family", kind: "shared" }],
};

function checklist(text: string): string[] {
  return text.split("\n").filter((line) => /^(Access mode|Timezone|Location|Members|Calendars): /.test(line));
}

function patchOf(text: string): { plugins: { entries: { "oc-family-pack": { config: Record<string, unknown> } } } } {
  const start = text.indexOf(`${PATCH_INTRO}\n`);
  assert.notEqual(start, -1, text);
  const body = text.slice(start + PATCH_INTRO.length + 1);
  return JSON.parse(body.slice(0, body.indexOf("\n}\n") + 2));
}

test("a finished setup lists every part as Done and passes", () => {
  const result = planSetup(host(complete), {}, READY, "UTC");
  assert.equal(result.ok, true);
  assert.deepEqual(checklist(result.text), [
    "Access mode: Done",
    "Timezone: Done",
    "Location: Done",
    "Members: Done",
    "Calendars: Done",
  ]);
  assert.equal(result.text.split("\n").at(-1), "Everything is set up.");
});

test("an empty install lists every part as To do and names the first step", () => {
  const result = planSetup({}, {}, MISSING, "America/Halifax");
  assert.equal(result.ok, false);
  assert.deepEqual(checklist(result.text).map((line) => line.split(": ")[1]), ["To do", "To do", "To do", "To do", "To do"]);
  assert.equal(result.text.split("\n").at(-1), "Next: `openclaw family access`");
});

test("the next step is the first part still to do, in checklist order", () => {
  const cases: [Record<string, unknown>, GogSetupPlan, RegExp][] = [
    [{ ...complete, timezone: undefined }, READY, /^Next: Set `timezone`, like `America\/Halifax`\. Until then the week uses this machine's time zone\.\n`openclaw config set plugins\.entries\.oc-family-pack\.config\.timezone America\/Halifax`$/m],
    [{ ...complete, location: undefined }, READY, /^Next: Add location \{ lat, lon \} to the plugin config to show local weather\.\n`openclaw config set plugins\.entries\.oc-family-pack\.config\.location '\{"lat":LAT,"lon":LON\}' --strict-json`$/m],
    [{ ...complete, members: [] }, READY, /^Next: Add at least one parent with `--parent NAME`\.$/m],
    [{ ...complete, members: [{ ...ALEX, role: "kid" }] }, READY, /^Next: Add at least one parent with `--parent NAME`\.$/m],
    [{ ...complete, calendars: [] }, READY, /^Next: `openclaw family gog`$/m],
    [complete, MISSING, /^Next: `openclaw family gog`$/m],
  ];
  for (const [config, gog, next] of cases) {
    const result = planSetup(host(config), {}, gog, "America/Halifax");
    assert.equal(result.ok, false, JSON.stringify(config));
    assert.match(result.text, next);
    assert.equal(checklist(result.text).filter((line) => line.endsWith("To do")).length, 1, result.text);
  }
});

test("a timezone counts only when the config sets it, not when the machine's zone fills it in", () => {
  const { timezone: _unset, ...config } = complete;
  assert.match(planSetup(host(config), {}, READY, "UTC").text, /^Timezone: To do$/m);
});

test("access mode reuses the access checks, including a Gateway reachable from outside", () => {
  assert.match(planSetup(host(complete, { bind: "lan" }), {}, READY, "UTC").text, /^Access mode: To do$/m);
  const outside = { ...SOLO, tailscale: { mode: "funnel" } };
  assert.match(planSetup(host(complete, outside), {}, READY, "UTC").text, /^Access mode: To do$/m);
});

test("in LAN mode a member missing from allowUsers can't sign in, and the step names them", () => {
  const gateway = lanGateway();
  const riley = { id: "riley", profileId: "riley", displayName: "Riley", role: "kid" };
  const result = planSetup(host({ ...complete, members: [ALEX, riley] }, gateway), {}, READY, "UTC");
  assert.match(result.text, /^Access mode: Done$/m);
  assert.match(result.text, /^Members: To do$/m);
  assert.match(
    result.text,
    /^Next: riley isn't in `allowUsers` yet, so they can't sign in\. Run `openclaw family access lan` again with everyone in the family, so the new list includes riley\.\n`openclaw family access lan --parent alex --kid riley`$/m,
  );
  assert.match(planSetup(host({ ...complete, members: [ALEX] }, gateway), {}, READY, "UTC").text, /^Members: Done$/m);
});

test("adding riley keeps alex exactly as written and puts riley after him", () => {
  const result = planSetup(host(complete), { kid: ["riley"] }, READY, "UTC");
  const config = patchOf(result.text).plugins.entries["oc-family-pack"].config;
  assert.deepEqual(Object.keys(config), ["members"]);
  const members = config.members as Record<string, unknown>[];
  assert.equal(JSON.stringify(members[0]), JSON.stringify(ALEX));
  assert.deepEqual(members[1], { id: "riley", profileId: "riley", displayName: "Riley", role: "kid" });
  assert.equal(members.length, 2);
  assert.ok(result.text.indexOf(PATCH_INTRO) < result.text.indexOf("{"), "the dry-run line comes before the patch");
});

test("a name already in the family is skipped by name, and a second run has no changes", () => {
  const first = planSetup(host(complete), { parent: ["alex"], kid: ["riley"] }, READY, "UTC");
  assert.match(first.text, /^alex is already set up, so that entry was left as it is\.$/m);
  const members = patchOf(first.text).plugins.entries["oc-family-pack"].config.members as unknown[];
  assert.deepEqual(members.map((member) => (member as { profileId: string }).profileId), ["alex", "riley"]);

  const second = planSetup(host({ ...complete, members }), { parent: ["alex"], kid: ["riley"] }, READY, "UTC");
  assert.equal(second.text.includes(PATCH_INTRO), false);
  assert.match(second.text, /^riley is already set up, so that entry was left as it is\.\nNo changes to make\.$/m);
  assert.equal(second.ok, true);
});

test("setup and access share the username rule and its copy", () => {
  const setup = planSetup(host(complete), { parent: ["Alex Smith"] }, READY, "UTC");
  const access = planAccess("lan", { parent: ["Alex Smith"] }, {});
  assert.equal(setup.ok, false);
  assert.equal(setup.text, access.text);
  const twice = planSetup(host(complete), { parent: ["sam"], kid: ["sam"] }, READY, "UTC");
  assert.equal(twice.text, planAccess("lan", { parent: ["sam"], kid: ["sam"] }, {}).text);
});

test("the access command keeps everyone already in allowUsers, with the role their scopes give them", () => {
  const lan = JSON.parse(/^Gateway config:\n(\{[\s\S]*?^\})$/m.exec(planAccess("lan", { parent: ["alex", "sam"], names: ["pat"] }, {}).text)?.[1] ?? "{}").gateway;
  const identityScopes = { alex: ["operator.read", "operator.write", "operator.sessions.write"], sam: ["operator.sessions.write", "operator.write", "operator.read"] };
  const gateway = { ...lan, controlUi: { ...lan.controlUi, allowedOrigins: ["https://192.168.1.20"] }, auth: { ...lan.auth, password: "x", identityScopes } };
  const riley = { id: "riley", profileId: "riley", displayName: "Riley", role: "kid" };
  const result = planSetup(host({ ...complete, members: [ALEX, riley] }, gateway), {}, READY, "UTC");
  // sam keeps parent from his scopes; pat has none, so stays the guest access made him.
  assert.match(result.text, /^`openclaw family access lan --parent alex --guest pat --kid riley --parent sam`$/m);
});

const SNOWFLAKE = "100000000000000001";

function lanGateway(extra: Record<string, unknown> = {}) {
  const text = planAccess("lan", { parent: ["alex"] }, {}).text;
  const blocks = [...text.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => JSON.parse(match[0]) as { gateway: Record<string, unknown> });
  const lan = blocks[0]?.gateway ?? {};
  const roles = blocks[1]?.gateway ?? {};
  const auth = { ...(lan.auth as object), ...(roles.auth as object), password: "x" };
  return { ...lan, ...roles, controlUi: { ...(lan.controlUi as object), allowedOrigins: ["https://192.168.1.20"] }, auth, ...extra };
}

test("a Discord ID changes only that person's discordId and keeps everything else as written", () => {
  const result = planSetup(host(complete), { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC");
  const config = patchOf(result.text).plugins.entries["oc-family-pack"].config;
  assert.deepEqual(Object.keys(config), ["members"]);
  const [alex, ...rest] = config.members as Record<string, unknown>[];
  assert.equal(rest.length, 0);
  assert.equal(JSON.stringify(alex), JSON.stringify({ ...ALEX, id: "alex", discordId: SNOWFLAKE }));
  // Solo has no per-person profiles, so there is nothing to link.
  assert.equal(result.text.includes("users.linkChannelIdentity"), false);
});

test("a placeholder or a mention is refused before any patch is printed", () => {
  for (const pair of ["alex=DISCORD_ID_alex", `alex=<@${SNOWFLAKE}>`, SNOWFLAKE, `=${SNOWFLAKE}`]) {
    const result = planSetup(host(complete), { discord: [pair] }, READY, "UTC");
    assert.equal(result.ok, false);
    assert.equal(result.text, "Give each Discord ID as `--discord NAME=ID`. The ID is the number Copy User ID gives you, 17 to 20 digits long.");
  }
});

test("a Discord ID needs a person in the family, which can be someone added in the same command", () => {
  const stranger = planSetup(host(complete), { discord: [`riley=${SNOWFLAKE}`] }, READY, "UTC");
  assert.equal(stranger.text, "`riley` isn't in the family yet. Add them with `--parent`, `--kid` or `--guest` in the same command.");
  const added = planSetup(host(complete), { kid: ["riley"], discord: [`riley=${SNOWFLAKE}`] }, READY, "UTC");
  const members = patchOf(added.text).plugins.entries["oc-family-pack"].config.members as Record<string, unknown>[];
  assert.equal(JSON.stringify(members[0]), JSON.stringify(ALEX));
  assert.deepEqual(members[1], { id: "riley", profileId: "riley", displayName: "Riley", role: "kid", discordId: SNOWFLAKE });
});

test("two people can't share a Discord ID, and an ID that's already set is no change", () => {
  const withId = { ...complete, members: [{ ...ALEX, id: "alex", discordId: SNOWFLAKE }] };
  const shared = planSetup(host(withId), { kid: ["riley"], discord: [`riley=${SNOWFLAKE}`] }, READY, "UTC");
  assert.equal(shared.text, "alex and riley have the same Discord ID. Each person needs their own.");
  const twice = planSetup(host(complete), { discord: [`alex=${SNOWFLAKE}`, `alex=100000000000000002`] }, READY, "UTC");
  assert.equal(twice.text, "`alex` has more than one Discord ID. Give each person one.");
  const same = planSetup(host(withId), { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC");
  assert.match(same.text, /^No changes to make\.$/m);
  assert.equal(same.text.includes(PATCH_INTRO), false);
});

test("in LAN mode the patch is followed by the link command, never a call", () => {
  const result = planSetup(host(complete, lanGateway()), { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC");
  assert.match(
    result.text,
    /^openclaw gateway call users\.linkChannelIdentity --params '\{"profileId":"PROFILE_alex","identity":\{"channelId":"discord","accountId":"default","senderId":"100000000000000001"\}\}'$/m,
  );
  assert.match(result.text, /^Replace each PROFILE_ placeholder with that person's profile id from `users\.list`\.$/m);
  assert.match(result.text, /^Run this after they've signed in once, so their profile exists\.\nopenclaw gateway call users\.linkChannelIdentity /m);
  assert.ok(result.text.indexOf("}\n\nThen link") > result.text.indexOf(PATCH_INTRO), "the link comes after the patch, outside it");

  const one = { ...host(complete, lanGateway()), channels: { discord: { accounts: { family: {} } } } };
  assert.match(planSetup(one, { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC").text, /"accountId":"family"/);
  const two = { ...host(complete, lanGateway()), channels: { discord: { accounts: { family: {}, work: {} } } } };
  const placeholder = planSetup(two, { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC").text;
  assert.match(placeholder, /"accountId":"ACCOUNT"/);
  assert.match(placeholder, /^Replace ACCOUNT with the `channels\.discord\.accounts` entry the family uses\.$/m);
});

test("people without a Discord ID get the optional command, which never holds up setup", () => {
  const riley = { id: "riley", profileId: "riley", displayName: "Riley", role: "kid" };
  const result = planSetup(host({ ...complete, members: [{ ...ALEX, discordId: SNOWFLAKE }, riley] }), {}, READY, "UTC");
  assert.equal(result.ok, true);
  assert.match(result.text, /^`openclaw family setup --discord riley=DISCORD_ID_riley`\nOptional\. In Discord, turn on Developer Mode, then right-click the person and pick Copy User ID\.$/m);
  assert.equal(checklist(result.text).length, 5, "Discord IDs are not a checklist line");
  const everyone = planSetup(host({ ...complete, members: [{ ...ALEX, discordId: SNOWFLAKE }] }), {}, READY, "UTC");
  assert.equal(everyone.text.includes("--discord"), false);
});

test("an email is stored on the card, a bad address is not repeated, and the lines above the patch leave it out", () => {
  const address = "riley@example.com";
  const added = planSetup(host(complete), { kid: ["riley"], email: [`riley=${address}`] }, READY, "UTC");
  const before = added.text.slice(0, added.text.indexOf(PATCH_INTRO));
  assert.equal(before.includes(address), false, before);
  assert.equal(before.includes("example.com"), false, before);
  const members = patchOf(added.text).plugins.entries["oc-family-pack"].config.members as Record<string, unknown>[];
  assert.equal(members[1]?.email, address);
  assert.deepEqual(members[0], ALEX);

  const bad = planSetup(host(complete), { kid: ["riley"], email: ["riley=not-an-email"] }, READY, "UTC");
  assert.equal(bad.ok, false);
  assert.equal(bad.text.includes("not-an-email"), false, bad.text);
  assert.match(bad.text, /riley's email doesn't look right/);

  const existing = planSetup(host({ ...complete, members: [{ ...ALEX, email: address }] }), { kid: ["riley"] }, READY, "UTC");
  const prose = existing.text.slice(0, existing.text.indexOf(PATCH_INTRO));
  assert.equal(prose.includes(address), false, prose);
  const kept = patchOf(existing.text).plugins.entries["oc-family-pack"].config.members as Record<string, unknown>[];
  assert.equal(kept[0]?.email, address);

  const stranger = planSetup(host(complete), { email: ["sam=sam@example.com"] }, READY, "UTC");
  assert.match(stranger.text, /`sam` isn't in the family yet/);
  assert.equal(stranger.text.includes("sam@example.com"), false, stranger.text);
  const twice = planSetup(host(complete), { email: ["alex=a@example.com", "alex=b@example.com"] }, READY, "UTC");
  assert.match(twice.text, /`alex` has more than one email/);
  assert.equal(twice.text.includes("example.com"), false, twice.text);
});

test("setup reads only pure modules: no Gateway, process, file or network imports", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./setup.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ["./access.ts", "./config.ts", "./directory.ts", "./gog-setup.ts", "./weather-ec.ts"]);
  assert.match(source, /^import type \{ GogSetupPlan \} from "\.\/gog-setup\.ts";$/m);
});

test("the login alias is the same field as profileId in setup checks", () => {
  const member = { name: "Riley", login: "riley-home", role: "kid" };
  const result = planSetup(host({ ...complete, members: [ALEX, member] }, lanGateway()), {}, READY, "UTC");
  assert.match(result.text, /^Members: To do$/m);
  assert.match(result.text, /riley-home isn't in `allowUsers`/);
  const added = planSetup(host(complete, lanGateway()), { discord: [`riley-home=${SNOWFLAKE}`] }, READY, "UTC");
  assert.equal(added.ok, false);
  assert.match(added.text, /isn't in the family yet/);
});

test("setup refuses a config the plugin would reject", () => {
  const duplicate = planSetup(host({ ...complete, members: [ALEX, { ...ALEX }] }), {}, READY, "UTC");
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.text, /needs fixing/);
  assert.match(duplicate.text, /same Control UI login|share the ID/);
});

test("setup reports a Gateway scope that does not match the roster role", () => {
  const gateway = lanGateway();
  const auth = gateway.auth as Record<string, unknown>;
  const proxy = auth.trustedProxy as Record<string, unknown>;
  const scopes = auth.identityScopes as Record<string, unknown>;
  (proxy.allowUsers as string[]).push("riley-home");
  scopes["riley-home"] = ["operator.read", "operator.write", "operator.sessions.write", "operator.approvals"];
  const riley = { name: "Riley", login: "riley-home", role: "kid" };
  const result = planSetup(host({ ...complete, members: [ALEX, riley] }, gateway), {}, READY, "UTC");
  assert.match(result.text, /^Members: To do$/m);
  assert.match(result.text, /scopes for Riley \(kid\) don't match/);
});

test("a complete LAN roster passes the preflight, including roles and allowUsers", () => {
  const result = planSetup(host(complete, lanGateway()), {}, READY, "UTC");
  assert.equal(result.ok, true);
  assert.deepEqual(checklist(result.text), [
    "Access mode: Done",
    "Timezone: Done",
    "Location: Done",
    "Members: Done",
    "Calendars: Done",
  ]);
  assert.match(result.text, /^Everything is set up\.$/m);
});

test("LAN setup prints the parent Discord approval targets", () => {
  const result = planSetup(host(complete, lanGateway()), { discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC");
  assert.match(result.text, /"approvals": \{/);
  assert.match(result.text, /"channel": "discord"/);
  assert.match(result.text, new RegExp(`"to": "user:${SNOWFLAKE}"`));
});

test("setup warns when a member id is still derived from a name or login", () => {
  const legacy = { ...complete, members: [{ profileId: "alex", displayName: "Alex P.", role: "parent" }] };
  const result = planSetup(host(legacy), {}, READY, "UTC");
  assert.match(result.text, /Alex P\. has no explicit member id/);
  assert.match(result.text, /--materialize-ids/);
  assert.match(result.text, /^The checklist is complete\. Run `openclaw family setup --materialize-ids`/m);
});

test("an email login gets a local-part id and display name, and the hint does not print the address", () => {
  const result = planSetup(host(complete), { parent: ["sam@example.com"] }, READY, "UTC");
  const members = patchOf(result.text).plugins.entries["oc-family-pack"].config.members as Record<string, unknown>[];
  const sam = members.find((member) => member.profileId === "sam@example.com");
  assert.equal(sam?.id, "sam");
  assert.equal(sam?.displayName, "Sam");
  assert.equal(result.text.includes("--discord sam@example.com="), false);
});

test("setup validates the member-id/channel-key namespace too", () => {
  const withChannel = { ...complete, channels: { alex: "222222222222222222" } };
  const result = planSetup(host(withChannel), { kid: ["alex"] }, READY, "UTC");
  assert.equal(result.ok, false);
  assert.match(result.text, /also a member id|channel key/);
});

test("a fresh LAN config prints approval targets for the parent added in the same run", () => {
  const result = planSetup(host({}, lanGateway()), { parent: ["alex"], discord: [`alex=${SNOWFLAKE}`] }, READY, "UTC");
  assert.match(result.text, /"approvals": \{/);
  assert.match(result.text, new RegExp(`"to": "user:${SNOWFLAKE}"`));
});

test("an extra operator.admin scope still counts as a parent", () => {
  const gateway = lanGateway();
  const scopes = (gateway.auth as Record<string, unknown>).identityScopes as Record<string, string[]>;
  scopes.alex = [...(scopes.alex ?? []), "operator.admin"];
  const result = planSetup(host(complete, gateway), {}, READY, "UTC");
  assert.match(result.text, /^Members: Done$/m);
});

test("setup refuses a malformed location through the plugin parser", () => {
  const result = planSetup(host({ ...complete, location: { lat: 44.65 } }), {}, READY, "UTC");
  assert.equal(result.ok, false);
  assert.match(result.text, /needs fixing/);
  assert.match(result.text, /location\.lon/);
});

test("calendar owners are checked against member ids, not logins", () => {
  const member = { id: "alex", login: "alex@example.com", name: "Alex", role: "parent" };
  const hostConfig = {
    ...complete,
    members: [member],
    calendars: [{ id: "alex@example.com", label: "Alex", kind: "personal", owners: ["alex"] }],
  };
  const result = planSetup(host(hostConfig, lanGateway()), {}, READY, "UTC");
  assert.match(result.text, /^Calendars: Done$/m);
});

test("setup recognizes an approvals block that is already applied", () => {
  const member = { ...ALEX, discordId: SNOWFLAKE };
  const configured = { ...complete, members: [member] };
  const hostWithApprovals = {
    ...host(configured, lanGateway()),
    approvals: { plugin: { enabled: true, mode: "targets", targets: [{ channel: "discord", to: `user:${SNOWFLAKE}` }] } },
  };
  const result = planSetup(hostWithApprovals, {}, READY, "UTC");
  assert.equal(result.ok, true);
  assert.equal(result.text.includes("Gateway plugin approvals:"), false);
  assert.match(result.text, /^Everything is set up\.$/m);
});

test("setup still prints the approvals block when a target or account is missing", () => {
  const member = { ...ALEX, discordId: SNOWFLAKE };
  const missingTarget = { ...complete, members: [member] };
  const noTargets = { ...host(missingTarget, lanGateway()), approvals: { plugin: { enabled: true, mode: "targets", targets: [] } } };
  assert.match(planSetup(noTargets, {}, READY, "UTC").text, /Gateway plugin approvals:/);
  const wrongAccount = { ...complete, discordAccount: "family", members: [member] };
  const wrongAccountHost = {
    ...host(wrongAccount, lanGateway()),
    approvals: { plugin: { enabled: true, mode: "targets", targets: [{ channel: "discord", to: `user:${SNOWFLAKE}` }] } },
  };
  assert.match(planSetup(wrongAccountHost, {}, READY, "UTC").text, /Gateway plugin approvals:/);
});

test("a trusted-proxy Gateway that omits accessMode is treated as LAN", () => {
  const { accessMode: _ignored, ...withoutMode } = complete;
  const result = planSetup(host(withoutMode, lanGateway()), {}, READY, "UTC");
  assert.equal(result.ok, true);
  assert.equal(result.text.includes("accessMode"), false);
});
