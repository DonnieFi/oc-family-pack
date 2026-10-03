import assert from "node:assert/strict";
import { test } from "node:test";
import { planAccess } from "./access.ts";
import type { GogSetupPlan } from "./gog-setup.ts";
import { PATCH_INTRO, planSetup } from "./setup.ts";

const READY: GogSetupPlan = { status: "ready", command: "gog calendar calendars --json --no-input", message: "" };
const MISSING: GogSetupPlan = { status: "missing", command: "brew install openclaw/tap/gogcli", message: "" };
const SOLO = { bind: "loopback", controlUi: { experimental: { customPlugins: true } } };
const ALEX = {
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
    [{ ...complete, location: { lat: 44.65 } }, READY, /^Next: Add location \{ lat, lon \} to the plugin config to show local weather\.\n`openclaw config set plugins\.entries\.oc-family-pack\.config\.location '\{"lat":LAT,"lon":LON\}' --strict-json`$/m],
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
  const lan = JSON.parse(/^Gateway config:\n(\{[\s\S]*?^\})$/m.exec(planAccess("lan", { parent: ["alex"] }, {}).text)?.[1] ?? "{}").gateway;
  const gateway = { ...lan, controlUi: { ...lan.controlUi, allowedOrigins: ["https://192.168.1.20"] }, auth: { ...lan.auth, password: "x" } };
  const riley = { profileId: "riley", displayName: "Riley", role: "kid" };
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
  assert.deepEqual(members[1], { profileId: "riley", displayName: "Riley", role: "kid" });
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
  const riley = { profileId: "riley", displayName: "Riley", role: "kid" };
  const result = planSetup(host({ ...complete, members: [ALEX, riley] }, gateway), {}, READY, "UTC");
  // sam keeps parent from his scopes; pat has none, so stays the guest access made him.
  assert.match(result.text, /^`openclaw family access lan --parent alex --guest pat --kid riley --parent sam`$/m);
});
