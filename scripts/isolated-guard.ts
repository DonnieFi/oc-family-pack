/**
 * Refuse an isolated OpenClaw command that would touch the live Gateway.
 * The smoke already avoids its ports. This is the same line for the build
 * harness: a state dir, a port, or a pid that belongs to the live Gateway.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIVE_PORTS } from "./smoke-ports.ts";

/** The operator's state dir: OPENCLAW_STATE_DIR, or ~/.openclaw. */
export function liveStateDir(env: NodeJS.ProcessEnv): string {
  const set = env.OPENCLAW_STATE_DIR?.trim();
  if (set) return set;
  const home = env.HOME?.trim();
  return home ? join(home, ".openclaw") : "";
}

function identity(path: string): string {
  if (path === "") return "";
  const full = resolve(path);
  try {
    return existsSync(full) ? realpathSync(full) : full;
  } catch {
    return full;
  }
}

/** Integer arguments, including the value of `--port`. */
export function integersInArgs(args: readonly string[]): number[] {
  const values: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--port") {
      const next = args[index + 1];
      if (next !== undefined && /^\d+$/.test(next)) values.push(Number(next));
      index += 1;
      continue;
    }
    const inline = arg.startsWith("--port=") ? arg.slice("--port=".length) : arg;
    if (/^\d+$/.test(inline)) values.push(Number(inline));
  }
  return values;
}

/** A process whose command line is the OpenClaw gateway. */
export function commandLooksLikeGateway(cmdline: string): boolean {
  return cmdline.includes("openclaw") && /\bgateway\b/.test(cmdline);
}

function defaultIsLiveGatewayPid(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return commandLooksLikeGateway(cmdline);
  } catch {
    return false;
  }
}

/**
 * Why this command must not run, or undefined when the temp state and the
 * arguments stay off the live Gateway. The message names no path.
 */
export function guardRefusal(input: {
  stateDir: string;
  liveStateDir: string;
  args: readonly string[];
  isLiveGatewayPid?: (pid: number) => boolean;
}): string | undefined {
  if (identity(input.stateDir) !== "" && identity(input.stateDir) === identity(input.liveStateDir)) {
    return "refusing to use the live Gateway state directory";
  }
  const isLive = input.isLiveGatewayPid ?? defaultIsLiveGatewayPid;
  for (const value of integersInArgs(input.args)) {
    if (LIVE_PORTS.includes(value)) return `refusing port ${value}, which belongs to the live Gateway`;
    if (isLive(value)) return `refusing pid ${value}, which is the live Gateway`;
  }
  return undefined;
}
