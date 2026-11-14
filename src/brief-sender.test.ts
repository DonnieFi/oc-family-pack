import assert from "node:assert/strict";
import { test } from "node:test";
import { briefSenderAgentId } from "./brief-sender.ts";

// Fixture uses the valid authored (implicit route) binding shape.
const host = {
  agents: { entries: { primary: { default: true }, household: {} } },
  bindings: [{ agentId: "household", match: { channel: "discord", accountId: "family" } }],
} as unknown as Parameters<typeof briefSenderAgentId>[1];

test("explicit sending account uses its routed agent, not the installation default", () => {
  assert.equal(briefSenderAgentId({ discordAccount: "family" }, host), "household");
});
test("omitted account preserves default-agent attribution", () => {
  assert.equal(briefSenderAgentId({}, host), "primary");
});
test("unbound account falls back through host routing", () => {
  assert.equal(briefSenderAgentId({ discordAccount: "other" }, host), "primary");
});
test("multi-agent host with no default falls back to main or the first configured agent", () => {
  const withMain = {
    agents: { list: [{ id: "helper" }, { id: "main" }] },
  } as unknown as Parameters<typeof briefSenderAgentId>[1];
  const withoutMain = {
    agents: { list: [{ id: "helper" }, { id: "family" }] },
  } as unknown as Parameters<typeof briefSenderAgentId>[1];
  assert.equal(briefSenderAgentId({}, withMain), "main");
  assert.equal(briefSenderAgentId({ discordAccount: "other" }, withMain), "main");
  assert.equal(briefSenderAgentId({}, withoutMain), "helper");
  assert.equal(briefSenderAgentId({ agentId: "family" }, withoutMain), "family");
  assert.equal(briefSenderAgentId({ agentId: "Household", discordAccount: "family" }, host), "household");
  assert.throws(
    () => briefSenderAgentId({ agentId: "family", discordAccount: "family" }, host),
    /not one of the configured agents/,
  );
});

test("an explicit fleet uses the system agent a template install records", () => {
  const explicit = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "Hopper" } },
      entries: { hopper: {}, coding: {} },
    },
  } as unknown as Parameters<typeof briefSenderAgentId>[1];
  assert.equal(briefSenderAgentId({}, explicit), "hopper");
  assert.equal(
    briefSenderAgentId({ discordAccount: "family" }, {
      ...explicit,
      bindings: [{ agentId: "coding", match: { channel: "discord", accountId: "family" } }],
    } as unknown as Parameters<typeof briefSenderAgentId>[1]),
    "coding",
  );
});

test("an empty roster does not invent main", () => {
  const empty = { agents: { entries: {} } } as unknown as Parameters<typeof briefSenderAgentId>[1];
  assert.throws(() => briefSenderAgentId({ agentId: "hopper" }, empty), /not one of the configured agents \(none\)/);
  assert.throws(() => briefSenderAgentId({}, empty), /No agents configured/);
});
