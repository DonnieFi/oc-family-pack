import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.ts";
import { resolveRequester, type Requester } from "./requester.ts";
import { SETUP_PERSON, writeRight } from "./write-permissions.ts";

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
  ],
});
const members = config.members;
const calendar = (id: string) => {
  const found = config.calendars.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
};

const tool = (fields: Record<string, unknown>) => ({ source: "tool", api: {}, toolCallId: "call-1", tool: fields }) as never;
const page = { source: "session-action", api: {}, action: {} } as never;
const command = { source: "command", api: {}, command: {} } as never;

const FROM = {
  "Calla on Discord": tool({ messageChannel: "discord", requesterSenderId: CALLA_DISCORD }),
  "Donnie on Discord": tool({ messageChannel: "discord", requesterSenderId: DONNIE_DISCORD }),
  "Nana on Discord": tool({ messageChannel: "discord", requesterSenderId: NANA_DISCORD }),
  "an unknown Discord sender claiming owner": tool({ messageChannel: "discord", requesterSenderId: "199999999999999999", senderIsOwner: true }),
  "Control UI chat as owner": tool({ messageChannel: "webchat", senderIsOwner: true }),
  "Control UI chat with Calla's Discord id": tool({ requesterSenderId: CALLA_DISCORD }),
  "the page": page,
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
  ["an unknown Discord sender claiming owner", "family", PARENTS],
  ["an unknown Discord sender claiming owner", "donnie", PARENTS],
  ["Control UI chat as owner", "donnie", PARENTS],
  ["Control UI chat as owner", "family", PARENTS],
  ["Control UI chat with Calla's Discord id", "calla", PARENTS],
  ["the page", "donnie", WRITE],
  ["the page", "calla", WRITE],
  ["the page", "family", WRITE],
  ["the page", "school-calla", WRITE],
  ["a command", "family", PARENTS],
];

for (const [from, id, expected] of TABLE) {
  test(`${from} writing to ${id}: ${expected.right}`, () => {
    assert.deepEqual(writeRight(members, resolveRequester(members, FROM[from]), calendar(id)), expected);
  });
}

test("an unknown requester in Control UI chat gets the rights of a kid with no calendar of their own", () => {
  const kidWithNoProfile: Requester = { from: "tool", senderIsOwner: false };
  for (const entry of config.calendars) {
    assert.deepEqual(writeRight(members, kidWithNoProfile, entry), writeRight(members, resolveRequester(members, FROM["Control UI chat as owner"]), entry));
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
  assert.deepEqual(resolveRequester(members, FROM["the page"]), { from: "page" });
  assert.deepEqual(resolveRequester(members, FROM["a command"]), { from: "other" });
  assert.deepEqual(resolveRequester(members, FROM["Calla on Discord"]), { from: "discord", member: members[2] });
  assert.deepEqual(resolveRequester(members, FROM["an unknown Discord sender claiming owner"]), { from: "discord" });
  assert.deepEqual(resolveRequester(members, tool({ messageChannel: "discord", senderIsOwner: true })), { from: "discord" });
  assert.deepEqual(resolveRequester(members, FROM["Control UI chat as owner"]), { from: "tool", senderIsOwner: true });
  assert.deepEqual(resolveRequester(members, FROM["Control UI chat with Calla's Discord id"]), { from: "tool", senderIsOwner: false });
});
