import assert from "node:assert/strict";
import { test } from "node:test";
import { familyContact } from "./contact.ts";
import { parseConfig } from "./config.ts";

const EMAIL = "riley@example.com";

function config() {
  return parseConfig({
    members: [
      { name: "Alex", profileId: "alex", role: "parent", email: "alex@example.com", discordId: "100000000000000001" },
      { name: "Riley", role: "kid", email: EMAIL, discordId: "100000000000000002" },
    ],
  });
}

function body(result: { content: { text: string }[] }): { id: string; name: string; email?: string; discordId?: string } {
  return JSON.parse(result.content[0]!.text) as { id: string; name: string; email?: string; discordId?: string };
}

test("the operator gets one member, and a direct operator does too", async () => {
  const owner = await familyContact(config(), { senderIsOwner: true }).execute("call", { id: "riley" });
  assert.deepEqual(body(owner), { id: "riley", name: "Riley", email: EMAIL, discordId: "100000000000000002" });
  assert.deepEqual(owner.details, { status: "ok" });
  const direct = await familyContact(config(), { directOperator: true }).execute("call", { id: "Alex" });
  assert.equal(body(direct).email, "alex@example.com");
  assert.equal(body(direct).id, "alex");
});

test("a kid, a parent who is not the operator, and a guest are refused, and the refusal names no address", async () => {
  const facts = [
    {},
    { senderIsOwner: false },
    { directOperator: false },
    { channel: "discord" },
  ];
  for (const fact of facts) {
    const result = await familyContact(config(), fact).execute("call", { id: "riley" });
    assert.equal(result.content[0]?.text, "Only the operator can look up a contact.");
    assert.equal(result.content[0]?.text.includes(EMAIL), false);
    assert.equal(result.content[0]?.text.includes("example.com"), false);
    assert.deepEqual(result.details, { status: "refused" });
  }
  const parent = await familyContact(config(), {}).execute("call", { id: "alex" });
  assert.equal(parent.content[0]?.text, "Only the operator can look up a contact.");
});

test("an unknown id, a blank id, and an email used as an id are refused without repeating the value", async () => {
  const tool = familyContact(config(), { senderIsOwner: true });
  assert.equal((await tool.execute("call", { id: "nope" })).content[0]?.text, "That person is not in the family.");
  assert.equal((await tool.execute("call", { id: "" })).content[0]?.text, "Say which person, by their id.");
  assert.equal((await tool.execute("call", {})).content[0]?.text, "Say which person, by their id.");
  const asEmail = await tool.execute("call", { id: EMAIL });
  assert.equal(asEmail.content[0]?.text, "That person is not in the family.");
  assert.equal(asEmail.content[0]?.text.includes(EMAIL), false);
  assert.equal(asEmail.content[0]?.text.includes("example.com"), false);
});
