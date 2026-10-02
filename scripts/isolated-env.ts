/**
 * Environment for the isolated smoke Gateway.
 *
 * Start from the caller's environment, then drop every `OPENCLAW_*` variable
 * and `PI_CODING_AGENT_DIR`. `OPENCLAW_WORKSPACE_DIR` selects the agent
 * workspace ahead of the state dir, and `PI_CODING_AGENT_DIR` points the
 * coding agent at the operator's real agent directory, so either one would
 * aim this Gateway at live files. The only OpenClaw variables set afterwards
 * are `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, both under the temp dir.
 *
 * Everything else is kept. The child is the operator's real `openclaw`
 * binary: it needs `PATH` to find Node and anything the host execs, `HOME`
 * because the host still resolves a user home for things that are not its
 * state dir, and the other non-OpenClaw basics of the caller's process
 * (locale, temp dir, TLS trust). An allowlist of only `PATH` and `HOME`
 * drops those and makes the same host fail, or behave differently, under
 * the operator's shell.
 */
const BLOCKED_EXACT = new Set(["PI_CODING_AGENT_DIR"]);

export function isolatedGatewayEnv(
  parent: NodeJS.ProcessEnv,
  paths: { stateDir: string; configPath: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (key.startsWith("OPENCLAW_") || BLOCKED_EXACT.has(key)) continue;
    env[key] = value;
  }
  env.OPENCLAW_STATE_DIR = paths.stateDir;
  env.OPENCLAW_CONFIG_PATH = paths.configPath;
  return env;
}
