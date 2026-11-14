import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBriefAgentName } from "./agent-name.ts";

test("brief agent name uses the Gateway default when available", () => {
  const config = { defaultAgent: "family" };
  let listed = false;
  assert.equal(
    resolveBriefAgentName(
      config,
      (value) => value.defaultAgent,
      (_value, id) => ({ name: id === "family" ? "Family Helper" : undefined }),
      () => {
        listed = true;
        return ["main", "family"];
      },
    ),
    "Family Helper",
  );
  assert.equal(listed, false, "the fallback only lists agents when the default is ambiguous");
});

test("brief agent name falls back to main when the Gateway default is ambiguous", () => {
  const config = { agents: ["main", "family"] };
  assert.equal(
    resolveBriefAgentName(
      config,
      () => {
        throw Object.assign(new Error("AgentSelectionRequiredError"), { code: "AGENT_SELECTION_REQUIRED" });
      },
      (_value, id) => ({ name: id === "main" ? "Primary Helper" : undefined }),
      (value) => value.agents,
    ),
    "Primary Helper",
  );
});

test("brief agent name falls back to a configured agent when the fleet has no main", () => {
  const config = { agents: ["adult", "kid"] };
  assert.equal(
    resolveBriefAgentName(
      config,
      () => {
        throw Object.assign(new Error("AgentSelectionRequiredError"), { code: "AGENT_SELECTION_REQUIRED" });
      },
      (_value, id) => ({ name: id === "adult" ? "Adult Helper" : undefined }),
      (value) => value.agents,
    ),
    "Adult Helper",
  );
});

test("brief agent name uses the agent id when its display name is unavailable", () => {
  assert.equal(
    resolveBriefAgentName({}, () => { throw Object.assign(new Error("ambiguous"), { code: "AGENT_SELECTION_REQUIRED" }); }, () => undefined, () => []),
    "main",
  );
});

test("brief agent name rethrows a host fault that is not agent ambiguity", () => {
  assert.throws(
    () =>
      resolveBriefAgentName(
        {},
        () => {
          throw new Error("No agents configured. Run `openclaw onboard` or `openclaw agents add` first.");
        },
        () => undefined,
        () => [],
      ),
    /No agents configured/,
  );
});
