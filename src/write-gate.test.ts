import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.ts";
import type { Grant } from "./grant.ts";
import type { Requester } from "./requester.ts";
import type { WriteMode } from "./types.ts";
import { gateWrite, READ_ONLY, VIEW_ONLY, WRITES_OFF } from "./write-gate.ts";

const config = parseConfig({
  timezone: "America/Halifax",
  members: [
    { profileId: "donnie", displayName: "Donnie", role: "parent", discordId: "100000000000000003" },
    { profileId: "calla", displayName: "Calla", role: "kid", discordId: "100000000000000001" },
  ],
  calendars: [
    { id: "family", label: "Family", kind: "shared", owners: ["donnie", "calla"] },
    { id: "calla", label: "Calla", kind: "personal", owners: ["calla"] },
  ],
});
const [donnie, calla] = config.members;
const family = config.calendars[0]!;
const callaCalendar = config.calendars[1]!;
const MODES: WriteMode[] = ["on", "confirm", "off"];

const parentPage: Requester = { from: "page", client: { scopes: ["operator.read", "operator.write", "operator.sessions.write"] } };
const adminPage: Requester = { from: "page", client: { scopes: ["operator.admin"] } };
const GUEST_PAGES: [string, Requester][] = [
  ["read-only", { from: "page", client: { scopes: ["operator.read"] } }],
  ["empty scopes", { from: "page", client: { scopes: [] } }],
  ["no client", { from: "page" }],
];
const GRANTS: Grant[] = ["read-write", "read-only", "unknown"];
const gate = (writes: WriteMode, requester: Requester, calendar = family, grant: Grant = "unknown") => gateWrite({ writes, grant, members: config.members, requester, calendar });

test("the view-only and off lines are exact", () => {
  assert.equal(VIEW_ONLY, "This page is view-only for you, so I didn't change anything.");
  assert.equal(WRITES_OFF, "Calendar changes are turned off right now, so I didn't change anything.");
  assert.equal(READ_ONLY, "I can only read the calendars right now, so I didn't change anything.");
});

test("gate 0: a page session that isn't a parent is view-only in every mode, before the off check", () => {
  for (const [name, requester] of GUEST_PAGES) {
    for (const writes of MODES) {
      for (const grant of GRANTS) {
        assert.deepEqual(gate(writes, requester, family, grant), { decision: "refused", message: VIEW_ONLY }, `${name} with writes ${writes}, ${grant}`);
        assert.deepEqual(gate(writes, requester, callaCalendar, grant), { decision: "refused", message: VIEW_ONLY }, `${name} with writes ${writes}, ${grant}`);
      }
    }
  }
});

test("writes off refuses every requester that gets past gate 0", () => {
  const discordParent: Requester = { from: "discord", member: donnie! };
  const discordKid: Requester = { from: "discord", member: calla! };
  for (const requester of [parentPage, adminPage, discordParent, discordKid, { from: "tool", senderIsOwner: true } as Requester, { from: "other" } as Requester]) {
    for (const grant of GRANTS) assert.deepEqual(gate("off", requester, family, grant), { decision: "refused", message: WRITES_OFF }, `${JSON.stringify(requester)} ${grant}`);
  }
});

test("writes on lets a parent page and an admin page write and keeps the permission table for everyone else", () => {
  assert.deepEqual(gate("on", parentPage), { decision: "write" });
  assert.deepEqual(gate("on", adminPage), { decision: "write" });
  assert.deepEqual(gate("on", { from: "discord", member: calla! }, callaCalendar), { decision: "write" });
  assert.deepEqual(gate("on", { from: "discord", member: calla! }), { decision: "needs-approval", approvers: ["Donnie"] });
});

test("writes confirm sends every write for approval, a parent's included", () => {
  for (const requester of [parentPage, adminPage, { from: "discord", member: donnie! } as Requester, { from: "discord", member: calla! } as Requester]) {
    assert.deepEqual(gate("confirm", requester, callaCalendar), { decision: "needs-approval", approvers: ["Donnie"] }, JSON.stringify(requester));
  }
});

test("a read-only grant refuses after gate 0 and off, before the permission table and confirm", () => {
  const requesters: Requester[] = [parentPage, adminPage, { from: "discord", member: donnie! }, { from: "discord", member: calla! }, { from: "tool", senderIsOwner: false }];
  for (const writes of ["on", "confirm"] as const) {
    for (const requester of requesters) {
      for (const calendar of [family, callaCalendar]) {
        assert.deepEqual(gate(writes, requester, calendar, "read-only"), { decision: "refused", message: READ_ONLY }, `${writes} ${JSON.stringify(requester)} ${calendar.id}`);
      }
    }
  }
});

test("an unknown or read-write grant lets the write through to the table", () => {
  for (const grant of ["unknown", "read-write"] as const) {
    assert.deepEqual(gate("on", parentPage, family, grant), { decision: "write" }, grant);
    assert.deepEqual(gate("on", { from: "discord", member: calla! }, family, grant), { decision: "needs-approval", approvers: ["Donnie"] }, grant);
    assert.deepEqual(gate("confirm", adminPage, family, grant), { decision: "needs-approval", approvers: ["Donnie"] }, grant);
  }
});
