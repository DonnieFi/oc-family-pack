import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isolatedGatewayEnv } from "../scripts/isolated-env.ts";

const stateDir = "/tmp/ocfp-smoke/state";
const configPath = "/tmp/ocfp-smoke/config.json";

test("caller OpenClaw overrides do not reach the isolated Gateway", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    OPENCLAW_WORKSPACE_DIR: "/operator/state",
    OPENCLAW_STATE_DIR: "/operator/state",
    OPENCLAW_CONFIG_PATH: "/operator/openclaw.json",
    OPENCLAW_GATEWAY_TOKEN: "not-a-real-token",
    PI_CODING_AGENT_DIR: "/operator/agent",
  };

  const env = isolatedGatewayEnv(parent, { stateDir, configPath });

  assert.equal(env.OPENCLAW_WORKSPACE_DIR, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(env.OPENCLAW_STATE_DIR, stateDir);
  assert.equal(env.OPENCLAW_CONFIG_PATH, configPath);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/operator");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.TMPDIR, "/tmp");
  assert.deepEqual(
    Object.keys(env).filter((key) => key.startsWith("OPENCLAW_")).sort(),
    ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"],
  );
  assert.equal(parent.OPENCLAW_WORKSPACE_DIR, "/operator/state");
  assert.equal(parent.PI_CODING_AGENT_DIR, "/operator/agent");
});

test("the smoke hands the isolated env to every Gateway call", () => {
  const smoke = readFileSync(new URL("../scripts/smoke.ts", import.meta.url), "utf8");
  assert.equal(
    smoke.match(/const env = isolatedGatewayEnv\(process\.env, \{ stateDir, configPath \}\);/g)?.length,
    1,
  );
  const boots = [...smoke.matchAll(/await bootGateway\(([^,]+),/g)].map((match) => match[1]);
  assert.ok(boots.length > 0);
  assert.deepEqual(boots.filter((arg) => arg !== "env"), []);
  // Host calls get env too, except the version probe, which runs before the temp dir exists.
  const calls = [...smoke.matchAll(/await oc\(\[([^\]]*)\],\s*([^,)]+)/g)].map((match) => ({ args: match[1], env: match[2] }));
  assert.ok(calls.length > 0);
  assert.deepEqual(
    calls.filter((call) => call.env !== "env" && call.args !== '"--version"'),
    [],
  );
});
