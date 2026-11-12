import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBriefAgentName } from "./agent-name.ts";

test("brief agent name uses the Gateway default when available", () => {
  const config = { defaultAgent: "family" };
  assert.equal(
    resolveBriefAgentName(config, (value) => value.defaultAgent, (_value, id) => ({ name: id === "family" ? "Family Helper" : undefined })),
    "Family Helper",
  );
});

test("brief agent name falls back to main when the Gateway default is ambiguous", () => {
  const config = { agents: ["main", "family"] };
  assert.equal(
    resolveBriefAgentName(
      config,
      () => {
        throw new Error("AgentSelectionRequiredError");
      },
      (_value, id) => ({ name: id === "main" ? "Primary Helper" : undefined }),
    ),
    "Primary Helper",
  );
});

test("brief agent name uses main id when its display name is unavailable", () => {
  assert.equal(
    resolveBriefAgentName({}, () => { throw new Error("ambiguous"); }, () => undefined),
    "main",
  );
});
