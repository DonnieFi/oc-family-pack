import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.ts";
import { resolveRequester, type Requester } from "./requester.ts";
import { pageRole, SETUP_PERSON, writeRight } from "./write-permissions.ts";

const CALLA_DISCORD = "100000000000000001";
const DONNIE_DISCORD = "100000000000000003";
const NANA_DISCORD = "100000000000000005";

const config = parseConfig({
  timezone: "America/Halifax",
  members: [
    { profileId: "donnie", displayName: "Donnie", role: "parent", discordId: DONNIE_DISCORD },
    { profileId: "britta", displayName: "Britta", role: "parent" },
    { profileId: "calla", displayName: "Calla", role: "kid", discordId: CALLA_DISCORD },
    { profileId: "penny", displayName: "Penny", role: "kid" },
    { profileId: "nana", displayName: "Nana", role: "guest", discordId: NANA_DISCORD },
  ],
  calendars: [
    { id: "donnie", label: "Donnie", kind: "personal", owners: ["donnie"] },
    { id: "calla", label: "Calla", kind: "personal", owners: ["calla"] },
    { id: "penny", label: "Penny", kind: "personal", owners: ["penny"] },
    { id: "house", label: "House", kind: "personal", owners: [] },
    { id: "family", label: "Family", kind: "shared", owners: ["donnie", "britta", "calla", "penny"] },
    { id: "school-calla", label: "Calla school", kind: "school", owners: ["calla"] },
    { id: "nana", label: "Nana", kind: "personal", owners: ["nana"] },
  ],
});
const members = config.members;
const calendar = (id: string) => {
  const found = config.calendars.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
};

const tool = (fields: Record<string, unknown>) => ({ source: "tool", api: {}, toolCallId: "call-1", tool: fields }) as never;
const PARENT_SCOPES = ["operator.read", "operator.write", "operator.sessions.write"];
const CLI_ADMIN_SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.pairing", "operator.talk.secrets"];
/** A page session as the host hands it over: `client` is the connection's granted scopes, `payload` is the browser's. */
const pageSession = (client?: unknown, payload?: unknown) =>
  ({ source: "session-action", api: {}, action: { pluginId: "oc-family-pack", actionId: "a", ...(client === undefined ? {} : { client }), ...(payload === undefined ? {} : { payload }) } }) as never;
const command = { source: "command", api: {}, command: {} } as never;

const FROM = {
  "Calla on Discord": tool({ messageChannel: "discord", requesterSenderId: CALLA_DISCORD }),
  "Donnie on Discord": tool({ messageChannel: "discord", requesterSenderId: DONNIE_DISCORD }),
  "Nana on Discord": tool({ messageChannel: "discord", requesterSenderId: NANA_DISCORD }),
  "an unknown Discord sender claiming owner": tool({ messageChannel: "discord", requesterSenderId: "199999999999999999", senderIsOwner: true }),
  "Control UI chat as owner": tool({ messageChannel: "webchat", senderIsOwner: true }),
  "Control UI chat with Calla's Discord id": tool({ requesterSenderId: CALLA_DISCORD }),
  "a parent's page": pageSession({ connId: "c1", scopes: PARENT_SCOPES }),
  "an admin's page": pageSession({ connId: "c2", scopes: ["operator.admin"] }),
  "a read-only page": pageSession({ connId: "c3", scopes: ["operator.read"] }),
  "a page with no client": pageSession(),
  "a command": command,
} as const;

const PARENTS = { right: "needs-approval", approvers: ["Donnie", "Britta"] } as const;
const WRITE = { right: "write" } as const;

// One row per acceptance case: who is asking, which calendar, what they get.
const TABLE: [keyof typeof FROM, string, typeof WRITE | typeof PARENTS][] = [
  ["Calla on Discord", "calla", WRITE],
  ["Calla on Discord", "donnie", PARENTS],
  ["Calla on Discord", "penny", PARENTS],
  ["Calla on Discord", "house", PARENTS],
  ["Calla on Discord", "family", PARENTS],
  ["Calla on Discord", "school-calla", PARENTS],
  ["Donnie on Discord", "donnie", WRITE],
  ["Donnie on Discord", "calla", WRITE],
  ["Donnie on Discord", "house", WRITE],
  ["Donnie on Discord", "family", WRITE],
  ["Donnie on Discord", "school-calla", WRITE],
  ["Nana on Discord", "family", PARENTS],
  ["Nana on Discord", "calla", PARENTS],
  ["Nana on Discord", "nana", PARENTS],
  ["Calla on Discord", "nana", PARENTS],
  ["an unknown Discord sender claiming owner", "family", PARENTS],
  ["an unknown Discord sender claiming owner", "donnie", PARENTS],
  ["Control UI chat as owner", "donnie", PARENTS],
  ["Control UI chat as owner", "family", PARENTS],
  ["Control UI chat with Calla's Discord id", "calla", PARENTS],
  ["a parent's page", "donnie", WRITE],
  ["a parent's page", "calla", WRITE],
  ["a parent's page", "family", WRITE],
  ["a parent's page", "school-calla", WRITE],
  ["an admin's page", "family", WRITE],
  ["an admin's page", "calla", WRITE],
  ["a read-only page", "family", PARENTS],
  ["a read-only page", "calla", PARENTS],
  ["a page with no client", "family", PARENTS],
  ["a command", "family", PARENTS],
];

for (const [from, id, expected] of TABLE) {
  test(`${from} writing to ${id}: ${expected.right}`, () => {
    assert.deepEqual(writeRight(members, resolveRequester(members, FROM[from]), calendar(id)), expected);
  });
}

test("an unknown requester in Control UI chat gets the rights of a kid with no calendar of their own", () => {
  const kidWithNoProfile: Requester = { from: "tool", senderIsOwner: false };
  const unmatchedGuest = resolveRequester(members, FROM["an unknown Discord sender claiming owner"]);
  for (const entry of config.calendars) {
    // Kid and guest differ only on their own personal calendar, which a caller with no profile never has.
    assert.deepEqual(writeRight(members, kidWithNoProfile, entry), writeRight(members, unmatchedGuest, entry), entry.id);
    assert.notDeepEqual(writeRight(members, kidWithNoProfile, entry), WRITE, entry.id);
  }
});

test("a denied write names every roster parent, and the setup person when there are none", () => {
  const calla = resolveRequester(members, FROM["Calla on Discord"]);
  assert.deepEqual(writeRight(members, calla, calendar("family")), PARENTS);
  const noParents = members.filter((member) => member.role !== "parent");
  assert.deepEqual(writeRight(noParents, resolveRequester(noParents, FROM["Calla on Discord"]), calendar("family")), {
    right: "needs-approval",
    approvers: [SETUP_PERSON],
  });
  assert.equal(SETUP_PERSON, "the person who set this up");
});

test("the requester comes only from the host's source and channel", () => {
  assert.deepEqual(resolveRequester(members, FROM["a parent's page"]), { from: "page", client: { scopes: PARENT_SCOPES } });
  assert.deepEqual(resolveRequester(members, FROM["a page with no client"]), { from: "page" });
  assert.deepEqual(resolveRequester(members, FROM["a command"]), { from: "other" });
  assert.deepEqual(resolveRequester(members, FROM["Calla on Discord"]), { from: "discord", member: members[2] });
  assert.deepEqual(resolveRequester(members, FROM["an unknown Discord sender claiming owner"]), { from: "discord" });
  assert.deepEqual(resolveRequester(members, tool({ messageChannel: "discord", senderIsOwner: true })), { from: "discord" });
  assert.deepEqual(resolveRequester(members, FROM["Control UI chat as owner"]), { from: "tool", senderIsOwner: true });
  assert.deepEqual(resolveRequester(members, FROM["Control UI chat with Calla's Discord id"]), { from: "tool", senderIsOwner: false });
});

test("a page session is a parent with operator.write or operator.admin and a guest otherwise", () => {
  assert.equal(pageRole({ scopes: PARENT_SCOPES }), "parent");
  assert.equal(pageRole({ scopes: ["operator.write"] }), "parent");
  assert.equal(pageRole({ scopes: ["operator.admin"] }), "parent");
  assert.equal(pageRole({ scopes: CLI_ADMIN_SCOPES }), "parent");
  assert.equal(pageRole({ scopes: ["operator.read"] }), "guest");
  assert.equal(pageRole({ scopes: ["operator.read", "operator.sessions.write"] }), "guest");
  assert.equal(pageRole({ scopes: [] }), "guest");
  assert.equal(pageRole({}), "guest");
  assert.equal(pageRole(undefined), "guest");
  assert.equal(pageRole({ scopes: "operator.write" as never }), "guest");
});

test("a page's role never comes from the payload", () => {
  const claims = { role: "parent", scopes: ["operator.write", "operator.admin"], client: { scopes: ["operator.admin"] }, requester: "page:parent" };
  for (const client of [{ connId: "c3", scopes: ["operator.read"] }, { connId: "c4", scopes: [] }, undefined]) {
    const requester = resolveRequester(members, pageSession(client, claims));
    assert.equal(requester.from, "page");
    assert.equal(requester.from === "page" ? pageRole(requester.client) : undefined, "guest", JSON.stringify(client));
    assert.deepEqual(writeRight(members, requester, calendar("family")), PARENTS, JSON.stringify(client));
  }
});
