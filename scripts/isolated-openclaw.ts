/**
 * Run an OpenClaw CLI command against a throwaway state dir.
 *
 * `plugins validate` and `plugins build --check` open the state database.
 * Without this wrapper they open ~/.openclaw, whose schema can be ahead of
 * the pinned CLI. The temp dir is removed when the command exits. Run it
 * through npm so this repo's pinned `openclaw` is first on PATH.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedGatewayEnv } from "./isolated-env.ts";

const args = process.argv.slice(2);
const command = args[0];
if (command === undefined) {
  console.error("usage: isolated-openclaw.ts <command> [args...]");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "ocfp-oc-"));
const stateDir = join(root, "state");
const configPath = join(root, "config.json");
mkdirSync(stateDir, { recursive: true });
// Keep the host log inside the temp dir. Otherwise it writes the shared
// /tmp/openclaw log that a live Gateway also uses.
writeFileSync(configPath, `${JSON.stringify({ logging: { file: join(root, "openclaw.log") } })}\n`);

let code = 1;
try {
  code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args.slice(1), {
      env: isolatedGatewayEnv(process.env, { stateDir, configPath }),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (status, signal) => {
      resolve(signal ? 1 : (status ?? 1));
    });
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
