/**
 * Post-update smoke for oc-family-pack.
 *
 * The feature-plugin and Control UI APIs are experimental, so the plugin pins a
 * tested host range instead of chasing version agnosticism. Run this after every
 * `openclaw update` on the operator's host: it boots an isolated Gateway on the
 * installed build and checks every integration point this plugin depends on. A
 * break fails with the name of the step that broke, not a stack trace.
 *
 *   npm run smoke
 *
 * The live Gateway is never touched. State, config, and the port all live under
 * a temp dir that is deleted on the way out, and the port is never 18789.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as pathResolve } from "node:path";
import { Value } from "typebox/value";
import { parseConfig } from "../src/config.ts";
import { MAX_WEEK_EVENTS, WEEK_METHOD, WeekPayloadSchema } from "../src/contract.ts";
import { buildWeekPayload, fitsHostLimits, jsonNodeCount } from "../src/payload.ts";
import { planAccess } from "../src/access.ts";
import { planSetup } from "../src/setup.ts";
import { POLL_MS } from "../src/calendar-watch.ts";
import { addDays } from "../src/week.ts";
import { isolatedGatewayEnv } from "./isolated-env.ts";

const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const PLUGIN_ID = "oc-family-pack";
const TOKEN = "ocfp-smoke-token";
/** The operator's live Gateway. This script must never bind or talk to it. */
const LIVE_GATEWAY_PORT = 18789;

/**
 * The `openclaw` binary to test. This must be the host the operator actually
 * runs, not the pinned devDependency: `npm run` puts `node_modules/.bin` first
 * on PATH, which would silently test the pinned build and make the smoke blind
 * to the very `openclaw update` it exists to check. Override with
 * OCFP_SMOKE_HOST_BIN, otherwise take the first `openclaw` on PATH that is not
 * this repo's own.
 */
function resolveHostBinary(): string {
  const override = process.env.OCFP_SMOKE_HOST_BIN;
  if (override?.trim()) {
    const candidate = override.trim();
    if (!existsSync(candidate)) {
      fail("host version", `OCFP_SMOKE_HOST_BIN points at ${candidate}, which does not exist`);
    }
    return candidate;
  }
  const own = join(ROOT, "node_modules", ".bin");
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || pathResolve(dir) === pathResolve(own)) continue;
    const candidate = join(dir, "openclaw");
    if (existsSync(candidate)) return candidate;
  }
  // Falling back to the bare name would resolve back to this repo's pinned
  // devDependency, which is the exact blindness this step exists to remove.
  fail(
    "host version",
    `no openclaw found on PATH outside this repo's node_modules/.bin. Set OCFP_SMOKE_HOST_BIN to the OpenClaw you want tested.`,
  );
}

type Step =
  | "host version"
  | "plugin load"
  | "manifest"
  | "contract validation"
  | "family.week query"
  | "page registration"
  | "service scheduler"
  | "sqlite store"
  | "host json limits"
  | "update path"
  | "household sign-in"
  | "calendar watch"
  | "family_schedule tool"
  | "garbage_schedule tool";

let workDir: string | undefined;
let gateway: ChildProcess | undefined;
/** Set to keep the isolated state on disk for inspection after a failure. */
const keepWorkDir = process.env.OCFP_SMOKE_KEEP === "1";
/**
 * Resolved inside main(), not at module scope: a missing host is a normal
 * failure this script reports by name, and throwing during import would print a
 * stack trace instead.
 */
let hostBinary = "openclaw";

function fail(step: Step, detail: string): never {
  throw new Error(`smoke: ${step} failed: ${detail}`);
}

/**
 * Records a completed step, and refuses to keep going if the run was cancelled.
 * Every step boundary goes through here, which is what stops a Ctrl-C partway
 * through from printing a false "all steps passed": without this the remaining
 * steps would run to completion and the cancelled run would look clean.
 */
function note(message: string, step: Step = "plugin load"): void {
  if (interrupted) fail(step, `interrupted by ${interrupted} after "${message}"`);
  process.stdout.write(`  ${message}\n`);
}

/** A host call must not hang the smoke: an interactive prompt would wait forever. */
const HOST_CALL_TIMEOUT_MS = 120_000;
/** Grace period before a child that ignored SIGTERM is killed outright. */
const HOST_KILL_ESCALATION_MS = 2000;
/** Cap per stream, so a chatty host cannot grow a string until the process dies. */
const MAX_HOST_OUTPUT = 8 * 1024 * 1024;
/** Time allowed for output to drain after a child exits, before settling. */
const OUTPUT_DRAIN_GRACE_MS = 250;
/**
 * Last-resort exit, so a leaked child holding our pipes cannot hang the shell.
 * Must exceed the kill escalation and the Gateway stop deadline, so the kills
 * have landed before the process goes away.
 */
const FORCED_EXIT_MS = 30000;
/** Backstop on waiting for the isolated Gateway to actually die. */
const GATEWAY_STOP_DEADLINE_MS = 10000;
/** Backstop on waiting for an aborted host call's process group to die. */
const KILL_WAIT_DEADLINE_MS = 10000;

/**
 * Runs the resolved host CLI against the isolated state, returning stdout.
 *
 * Hand-rolled rather than promisified execFile because of four things that all
 * mattered in practice:
 * - async, because a synchronous child blocks the event loop and a Ctrl-C
 *   during a multi-second host call would not be delivered until it returned,
 *   letting the cancelled run finish and report success;
 * - stdin is /dev/null, so a host that prompts for input gets EOF instead of
 *   hanging the smoke unkillably;
 * - the call is raced against an interrupt and a timeout, and killGroup takes
 *   the child's whole process group down on either, keeping signalling until
 *   the group is gone, so a host that ignores SIGTERM or leaves a background
 *   child behind cannot outlive the run;
 * - output is capped, so a chatty host cannot grow a string until the process
 *   dies instead of reporting the step that broke.
 *
 * Every failure path names its step. A bare rejection here would lose that,
 * and naming the step is the whole contract of this script.
 */
/**
 * Signals a child's whole process group, escalating to SIGKILL, and keeps going
 * until the group is really gone.
 *
 * Two things this has to get right, both of which were wrong before it existed:
 * the escalation must outlive the settle of the caller's promise, or a host
 * that ignores SIGTERM survives its own timeout; and it must keep signalling
 * after the direct child has exited, or a host that left a background child
 * behind orphans it. `alive` is therefore about the *group*, not the child.
 */
function killGroup(child: ChildProcess, onGone?: () => void): void {
  const pid = child.pid;
  if (pid === undefined) {
    onGone?.();
    return;
  }
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  if (!groupAlive()) {
    onGone?.();
    return;
  }
  signal("SIGTERM");
  // Poll rather than fire once: the direct child can exit while its own
  // children are still alive, and only the group knows they are there.
  //
  // The poll stays ref'd while the group is genuinely alive, because otherwise
  // the process can exit before the SIGKILL tick and leave a SIGTERM-deaf
  // descendant behind. A healthy call's group is already empty by the time the
  // child exits, so the `groupAlive` check above returns without arming this at
  // all and a clean run pays nothing.
  const escalate = setInterval(() => {
    if (!groupAlive()) {
      clearInterval(escalate);
      onGone?.();
      return;
    }
    signal("SIGKILL");
  }, HOST_KILL_ESCALATION_MS);
}

function oc(args: string[], env: NodeJS.ProcessEnv, step: Step = "plugin load"): Promise<string> {
  return new Promise((resolve, reject) => {
    // Own process group, so a timeout or Ctrl-C can signal the host and
    // anything it spawned rather than orphaning them.
    const child = spawn(hostBinary, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const label = `${hostBinary} ${args.join(" ")}`;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const collect = (into: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (into === "out") {
        if (stdout.length < MAX_HOST_OUTPUT) stdout += text.slice(0, MAX_HOST_OUTPUT - stdout.length);
      } else if (stderr.length < MAX_HOST_OUTPUT) {
        stderr += text.slice(0, MAX_HOST_OUTPUT - stderr.length);
      }
    };
    // An EPIPE on a closed pipe must not throw out of a stream callback.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));

    // Settling the promise must not cancel the kill: that was how a host which
    // ignored SIGTERM outlived its own timeout.
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (backstop !== undefined) clearTimeout(backstop);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      fn();
    };
    // Why we are tearing this call down, if we are. The child will exit because
    // of our own kill, and that exit must not overwrite the real reason with a
    // bare "exited by SIGKILL".
    let abortReason: string | undefined;
    let backstop: NodeJS.Timeout | undefined;
    const abort = (detail: string) => {
      if (settled || abortReason !== undefined) return;
      abortReason = detail;
      // Arm the backstop before killing: killGroup can settle synchronously if
      // the group is already gone, and arming afterwards left a ref'd timer that
      // nothing cleared.
      backstop = setTimeout(() => settle(() => reject(new Error(`smoke: ${detail}`))), KILL_WAIT_DEADLINE_MS);
      killGroup(child, () => settle(() => reject(new Error(`smoke: ${detail}`))));
    };
    const onSignal = () => abort(`${step} failed: interrupted by ${interrupted ?? "signal"} during ${label}`);
    const timer = setTimeout(
      () => abort(`${step} failed: timed out after ${HOST_CALL_TIMEOUT_MS}ms running ${label}`),
      HOST_CALL_TIMEOUT_MS,
    );
    timer.unref();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    child.on("error", (error) =>
      settle(() => reject(new Error(`smoke: ${step} failed: could not run ${label}: ${error.message}`))),
    );
    // `exit` rather than `close`: close waits for the pipes to reach EOF, which
    // a surviving grandchild can hold open forever, turning a successful call
    // into a spurious timeout. Take a moment to drain, then settle. This timer
    // is deliberately not unref'd: it is what settles the promise, so if the
    // loop has nothing else pending it must be the thing keeping it alive.
    child.on("exit", (code) => {
      // Sweep the group even on success: a host that exits 0 while leaving a
      // background child would otherwise orphan it, since nothing else in the
      // run would ever signal that group again. It is our own group, so this
      // cannot touch anything else, and a healthy call's group is already empty
      // so it costs nothing.
      killGroup(child);
      setTimeout(() => {
        settle(() => {
          // If we killed this call, say why. Reporting "exited by SIGKILL"
          // instead of the timeout or interrupt that caused it would point the
          // operator at the host rather than at the smoke.
          if (abortReason !== undefined) {
            reject(new Error(`smoke: ${abortReason}`));
            return;
          }
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const how = code === null ? `by ${child.signalCode ?? "signal"}` : `with exit code ${code}`;
          reject(
            new Error(
              `smoke: ${step} failed: ${label} exited ${how}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
            ),
          );
        });
      }, OUTPUT_DRAIN_GRACE_MS);
    });
  });
}

/**
 * The host publishes its own bounded-JSON check under a content-hashed name.
 * Resolve it from the host under test, not from this repo's pinned
 * devDependency: the point of the step is to notice when the operator's host
 * changes those limits, and the pinned copy never moves.
 */
async function loadHostJsonCheck(): Promise<(value: unknown) => boolean> {
  const dist = hostDistDir();
  let match: string | undefined;
  try {
    match = readdirSync(dist).find((name) => name.startsWith("host-hook-json-") && name.endsWith(".mjs"));
  } catch (error) {
    fail("host json limits", `could not read ${dist} from the host at ${hostBinary}: ${(error as Error).message}`);
  }
  if (!match) {
    fail(
      "host json limits",
      `the host at ${hostBinary} no longer ships a host-hook-json module under ${dist}; re-derive HOST_MAX_NODES in src/payload.ts`,
    );
  }
  // The point of this step is to report a moved host by name, so importing the
  // host's module must not surface as a raw module-resolution error.
  let module: { t?: (value: unknown) => boolean };
  try {
    module = (await import(join(dist, match))) as { t?: (value: unknown) => boolean };
  } catch (error) {
    fail("host json limits", `could not import ${match} from the host at ${hostBinary}: ${(error as Error).message}`);
  }
  if (typeof module.t !== "function") fail("host json limits", `${match} no longer exports its JSON value check as \`t\``);
  return module.t;
}

/** Finds the `dist` that belongs to the host binary under test. */
function hostDistDir(): string {
  const hasHostJsonCheck = (dir: string): boolean => {
    // The module name carries a content hash that the host can change, so match
    // the prefix rather than one literal filename.
    try {
      return readdirSync(dir).some((name) => name.startsWith("host-hook-json-") && name.endsWith(".mjs"));
    } catch {
      return false;
    }
  };

  // node_modules/.bin/openclaw sits inside the package, so walk up a few levels
  // looking for the sibling dist/.
  let dir = dirname(realpathSync(hostBinary));
  for (let up = 0; up < 5; up += 1) {
    const candidate = join(dir, "dist");
    if (existsSync(candidate) && hasHostJsonCheck(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // A globally linked install may not sit next to its package, so try resolving
  // the module from the binary's own directory before giving up. Never fall back
  // to this repo's pinned copy: that is the blindness the step exists to avoid.
  try {
    const resolved = createRequire(import.meta.url).resolve("openclaw/package.json", {
      paths: [dirname(realpathSync(hostBinary))],
    });
    const candidate = join(dirname(resolved), "dist");
    if (existsSync(candidate) && hasHostJsonCheck(candidate)) return candidate;
  } catch {
    // fall through to the explicit failure below
  }
  fail(
    "host json limits",
    `could not find a host-hook-json module in the dist of the host at ${hostBinary}. If this host renamed or dropped it, re-derive HOST_MAX_NODES in src/payload.ts; set OCFP_SMOKE_HOST_BIN to choose the host to test.`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`smoke: plugin load failed: could not reserve a local port: ${error.message}`)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port === LIVE_GATEWAY_PORT
          ? reject(new Error(`smoke: plugin load failed: refused to use the live Gateway port ${LIVE_GATEWAY_PORT}`))
          : resolve(port),
      );
    });
  });
}

/** The files a git install would have, so the smoke exercises the shipped shape. */
const SHIPPED = ["package.json", "package-lock.json", "openclaw.plugin.json", "dist", "src", "README.md", "FAQ.md", "HOUSEHOLD-LAN.md", "CHANGELOG.md", "LICENSE", "skills"];

/**
 * Copies the shipping files into a fresh directory and installs the one runtime
 * dependency from the committed lockfile. `npm ci` fails when the lockfile is
 * missing or out of step with package.json. `openclaw` is deliberately left out: the host supplies it, and
 * nesting it inside the plugin is what the install step rejects.
 */
async function stagePlugin(target: string): Promise<void> {
  mkdirSync(target, { recursive: true });
  for (const entry of SHIPPED) {
    cpSync(join(ROOT, entry), join(target, entry), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
    fail("plugin load", "package.json declares no runtime dependencies, so the staged copy would be incomplete");
  }
  // Async and bounded, like every other child process here: a synchronous npm
  // blocked the event loop, so a Ctrl-C during it was not delivered until it
  // returned, and a stalled install could hang the run with no way out.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", target], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    // Drain stdout as well: an undrained pipe fills at 64 KiB and blocks npm,
    // which showed up as a spurious install timeout.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_HOST_OUTPUT) stderr += chunk.toString("utf8").slice(0, MAX_HOST_OUTPUT - stderr.length);
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    let settled = false;
    let abortReason: string | undefined;
    let backstop: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (backstop !== undefined) clearTimeout(backstop);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      fn();
    };
    const abort = (detail: string) => {
      if (settled || abortReason !== undefined) return;
      abortReason = detail;
      backstop = setTimeout(
        () => settle(() => reject(new Error(`smoke: plugin load failed: ${detail}`))),
        KILL_WAIT_DEADLINE_MS,
      );
      killGroup(child, () => settle(() => reject(new Error(`smoke: plugin load failed: ${detail}`))));
    };
    const onSignal = () => abort(`interrupted by ${interrupted ?? "signal"} during npm ci`);
    const timer = setTimeout(
      () => abort(`npm ci timed out after ${HOST_CALL_TIMEOUT_MS}ms`),
      HOST_CALL_TIMEOUT_MS,
    );
    timer.unref();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.on("error", (error) => settle(() => reject(new Error(`smoke: plugin load failed: could not run npm ci: ${error.message}`))));
    child.on("exit", (code) => {
      // Sweep the group on success too, for the same reason oc() does.
      killGroup(child);
      setTimeout(() => {
        settle(() => {
          // If we killed npm, report why rather than "exited by SIGKILL".
          if (abortReason !== undefined) {
            reject(new Error(`smoke: plugin load failed: ${abortReason}`));
            return;
          }
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `smoke: plugin load failed: npm ci exited ${
                  code === null ? `by ${child.signalCode ?? "signal"}` : `with exit code ${code}`
                }${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
              ),
            );
        });
      }, OUTPUT_DRAIN_GRACE_MS);
    });
  });
  if (existsSync(join(target, "node_modules", "openclaw"))) {
    fail("plugin load", "staged copy still has a nested openclaw in node_modules");
  }
}

/**
 * SIGKILL escalations in flight, so cleanup can await the child instead of
 * racing it. Kept across the signal handler, which stops the Gateway first:
 * the later stopGateway() in the cleanup path is then a no-op, so the promise
 * recorded here is what the cleanup actually waits on.
 */
const gatewayStops = new Set<Promise<void>>();

async function bootGateway(env: NodeJS.ProcessEnv, port: number, logPath: string): Promise<void> {
  await stopGateway();
  const out = openSync(logPath, "w");
  let spawnFailure: string | undefined;
  const child = spawn(hostBinary, ["gateway", "run", "--port", String(port), "--bind", "loopback"], {
    env,
    stdio: ["ignore", out, out],
    detached: true,
  });
  gateway = child;
  child.on("error", (error) => {
    spawnFailure = `could not start the isolated Gateway: ${error.message}`;
  });
  try {
    await waitForReady(
      logPath,
      () => spawnFailure,
      () => (gateway === child ? child.exitCode : null),
    );
  } catch (error) {
    await stopGateway();
    throw error;
  }
}

function stopGateway(): Promise<void> {
  const child = gateway;
  gateway = undefined;
  if (!child) {
    // An earlier stop may still be waiting for the child to die.
    return Promise.all([...gatewayStops]).then(() => undefined);
  }
  const stopped = new Promise<void>((resolve) => {
    // killGroup keeps signalling until the whole group is gone, then reports
    // back, so cleanup waits for the Gateway *and* anything it spawned. The
    // deadline is a backstop: a group that somehow survives SIGKILL must not
    // leave the operator's shell hanging with no exit code.
    let reported = false;
    let deadline: NodeJS.Timeout | undefined;
    const report = (forced: boolean) => {
      if (reported) return;
      reported = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (forced && child.exitCode === null && child.signalCode === null) {
        process.stderr.write("smoke: the isolated Gateway survived SIGKILL; giving up waiting for it\n");
      }
      resolve();
    };
    // Arm the backstop before killing. killGroup can report synchronously when
    // the group is already gone, and arming afterwards left a ref'd timer that
    // nothing cleared, so those runs sat for the full deadline before exiting.
    deadline = setTimeout(() => report(true), GATEWAY_STOP_DEADLINE_MS);
    killGroup(child, () => report(false));
  });
  gatewayStops.add(stopped);
  void stopped.then(() => gatewayStops.delete(stopped));
  return stopped;
}

/**
 * On an interrupt, stop the Gateway and let the failure path unwind normally so
 * the `finally` block still deletes the temp state. Calling process.exit() here
 * would skip that and leak the directory. The interrupt is also checked at every
 * step boundary, because stopping the Gateway makes the remaining steps fail for
 * the wrong reason, and a cancelled run must never report success.
 */
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted ??= signal;
    void stopGateway();
  });
}

async function waitForReady(
  logPath: string,
  spawnFailure: () => string | undefined,
  exited: () => number | null,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (interrupted) fail("plugin load", `interrupted by ${interrupted} while waiting for the isolated Gateway`);
    const spawnError = spawnFailure();
    if (spawnError) fail("plugin load", spawnError);
    const log = readFileSync(logPath, "utf8");
    const trouble = log.split("\n").filter((line) => /failed during register|refusing|failed to load plugin/i.test(line));
    if (trouble.length) fail("plugin load", trouble.slice(0, 3).join(" | ").slice(0, 500));
    // A Gateway that exits before it is ready will never become ready, so say
    // so now instead of after the full 120s.
    const code = exited();
    if (code !== null) {
      fail("plugin load", `the isolated Gateway exited with code ${code} before it was ready; log at ${logPath}`);
    }
    // Match the host's own final readiness line only. A bare "ready" substring
    // also matches "spawn broker ready" (which fires before the server listens)
    // and "already listening", so anchor on the gateway's ready line.
    if (/\[gateway\]\s*ready\s*$|\[gateway\].*\bready\b\s*$/m.test(stripAnsi(log))) {
      if (/http server listening/i.test(stripAnsi(log))) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail("plugin load", `isolated Gateway did not become ready within 120s; log at ${logPath}`);
}

/**
 * Lists files under `root` without following symlinks and without throwing on an
 * unreadable subdirectory. The real state dir contains symlinks into the host's
 * own node_modules and can hold directories this process cannot read, so a plain
 * recursive readdirSync risks ELOOP and EACCES and would surface as a raw fs
 * error instead of a named smoke step.
 */
function stateFiles(root: string, depth = 0): string[] {
  if (depth > 8) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...stateFiles(full, depth + 1));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * Parses host JSON, naming the step if the output is not JSON. A raw
 * SyntaxError from a banner, a warning, or output clipped at the cap would
 * otherwise reach the user with no indication of which step produced it.
 */
function parseHostJson(raw: string, step: Step, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const head = raw.trim().slice(0, 200);
    fail(
      step,
      `${what} did not return JSON${raw.length >= MAX_HOST_OUTPUT ? " (output was clipped, so it may have been truncated)" : ""}: ${
        (error as Error).message
      }${head ? `; output began: ${head}` : "; output was empty"}`,
    );
  }
}

/** Removes ANSI colour so log lines can be matched literally. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function storeDbPath(stateDir: string): string {
  return join(stateDir, "plugins", PLUGIN_ID, "oc-family-pack.sqlite");
}

function readMigrations(path: string): { id: string; applied_at: number }[] {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.DB, { readOnly: true });
    const rows = db.prepare("SELECT id, applied_at FROM oc_family_pack_schema_migrations ORDER BY id").all();
    db.close();
    process.stdout.write(JSON.stringify(rows));
  `;
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    env: { ...process.env, DB: path },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail("sqlite store", `could not read the migrations table: ${(result.stderr || "").trim().slice(0, 300)}`);
  }
  return JSON.parse(result.stdout) as { id: string; applied_at: number }[];
}

function assertStoreModes(path: string): void {
  const dirMode = statSync(join(path, "..")).mode & 0o777;
  if (dirMode !== 0o700) fail("sqlite store", `plugin directory mode is ${dirMode.toString(8)}, expected 700`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${path}${suffix}`;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!existsSync(file)) fail("sqlite store", `missing ${name} while the store is open`);
    const fileMode = statSync(file).mode & 0o777;
    if (fileMode !== 0o600) fail("sqlite store", `${name} mode is ${fileMode.toString(8)}, expected 600`);
  }
}

/** Inserts a scratch row into each log in a copy of the database and reports which changes the triggers refused. */
function readLogGuards(path: string): string[] {
  const copy = `${path}.guard-check`;
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const source = new DatabaseSync(process.env.DB, { readOnly: true });
    source.exec("VACUUM INTO '" + process.env.COPY.replaceAll("'", "''") + "'");
    source.close();
    const db = new DatabaseSync(process.env.COPY);
    db.exec("INSERT INTO oc_family_pack_write_log (request_key, base_key, requester, op, calendar_id, status, at) VALUES ('k.0', 'k', 'page', 'create', 'c', 'committed', 1)");
    db.exec("INSERT INTO oc_family_pack_delivery_log (delivery_key, kind, target, status, at) VALUES ('daily-summary:2026-11-01', 'daily', 'family', 'sent', 1)");
    db.exec("INSERT INTO oc_family_pack_reminder_mode (profile_id, mode, at) VALUES ('alex', 'dm', 1)");
    const blocked = [];
    for (const [name, sql] of [
      ["write update", "UPDATE oc_family_pack_write_log SET status = 'reverted'"],
      ["write delete", "DELETE FROM oc_family_pack_write_log"],
      ["delivery update", "UPDATE oc_family_pack_delivery_log SET target = 'kitchen'"],
      ["delivery delete", "DELETE FROM oc_family_pack_delivery_log"],
      ["reminder update", "UPDATE oc_family_pack_reminder_mode SET mode = 'off'"],
      ["reminder delete", "DELETE FROM oc_family_pack_reminder_mode"],
    ]) {
      try { db.exec(sql); } catch (error) { if (/append-only/.test(String(error))) blocked.push(name); }
    }
    db.close();
    process.stdout.write(JSON.stringify(blocked));
  `;
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    env: { ...process.env, DB: path, COPY: copy },
    encoding: "utf8",
  });
  rmSync(copy, { force: true });
  if (result.status !== 0) {
    fail("sqlite store", `could not check the logs: ${(result.stderr || "").trim().slice(0, 300)}`);
  }
  return JSON.parse(result.stdout) as string[];
}

async function waitForStore(stateDir: string): Promise<string> {
  const path = storeDbPath(stateDir);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return path;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("sqlite store", "the store database was not created");
}

async function main(): Promise<void> {
  // 1. The host must be the build this plugin was pinned and tested against.
  hostBinary = resolveHostBinary();
  const hostVersion = (await oc(["--version"], process.env, "host version")).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    openclaw: { build: { openclawVersion: string }; compat: { pluginApi: string } };
  };
  note(`host ${hostVersion}`, "host version");
  if (!hostVersion.includes(pkg.openclaw.build.openclawVersion)) {
    fail(
      "host version",
      `installed host ${hostVersion} does not match pinned build.openclawVersion ${pkg.openclaw.build.openclawVersion}; re-run the smoke and bump both together`,
    );
  }
  note(`pinned build.openclawVersion ${pkg.openclaw.build.openclawVersion} and compat.pluginApi ${pkg.openclaw.compat.pluginApi} match`, "host version");

  // 2. An isolated Gateway on the installed build, with this working tree linked in.
  workDir = mkdtempSync(join(tmpdir(), "ocfp-smoke-"));
  const stateDir = join(workDir, "state");
  const configPath = join(workDir, "config.json");
  const logPath = join(workDir, "gateway.log");
  mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  const env = isolatedGatewayEnv(process.env, { stateDir, configPath });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        // Keep the Gateway's own log inside the temp dir. Without this the host
        // writes to the shared /tmp/openclaw/openclaw-<date>.log that the live
        // Gateway also uses, so the smoke would leave traces outside the state
        // it is supposed to clean up.
        logging: { file: join(workDir, "openclaw.log") },
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: TOKEN },
          controlUi: { experimental: { customPlugins: true } },
        },
        plugins: {
          entries: { "oc-family-pack": { enabled: true, config: { demo: true, timezone: "America/Toronto" } } },
        },
      },
      null,
      2,
    ),
  );
  note(`isolated state at ${stateDir}, loopback:${port}`, "plugin load");
  note(`host binary ${hostBinary}`, "host version");

  // Install the way a real household does: a clean copy carrying only the files
  // that ship, plus its runtime dependency. The working tree is not installed
  // directly because a dev `npm install` leaves a real `openclaw` directory in
  // node_modules, and the host then counts the 64 bundled extensions it finds
  // there as children of our install record and refuses the install. A git
  // install links `openclaw` instead, and discovery does not follow the link.
  const sourceDir = join(workDir, "source");
  await stagePlugin(sourceDir);
  await oc(["plugins", "install", sourceDir, "--force", "--link", "--accept-capabilities"], env);
  note("plugin installed from a clean copy of the working tree", "plugin load");

  // 3. Manifest and build artifacts the host validates before it loads code.
  // A stale Control UI bundle is a build-toolchain mismatch, not a plugin
  // defect: two OpenClaw builds of the same version minify the page to
  // different identifier names, so the content hash in the manifest can only
  // satisfy one of them. Say so explicitly instead of implying the plugin broke.
  let validated: { valid?: boolean; errors?: unknown[] };
  try {
    validated = parseHostJson(await oc(["plugins", "validate", "--json"], env, "manifest"), "manifest", "plugins validate") as {
      valid?: boolean;
      errors?: unknown[];
    };
  } catch (error) {
    const detail = (error as Error).message;
    if (/Control UI build is missing or stale/i.test(detail)) {
      fail(
        "manifest",
        `the committed dist/ was built by a different OpenClaw build than this host, so the Control UI bundle hash does not match. ` +
          `Rebuild with the host you are testing: openclaw plugins build && openclaw plugins build --check, then commit the new dist/. (${detail})`,
      );
    }
    throw error;
  }
  if (validated.valid !== true) fail("manifest", `plugins validate reported ${JSON.stringify(validated.errors ?? validated)}`);
  note("manifest validates", "manifest");

  await bootGateway(env, port, logPath);
  note("isolated Gateway ready", "plugin load");

  const call = async (method: string, params: unknown, step: Step): Promise<Record<string, unknown>> => {
    const raw = await oc(
      ["gateway", "call", method, "--port", String(port), "--token", TOKEN, "--json", "--params", JSON.stringify(params)],
      env,
      step,
    );
    return parseHostJson(raw, step, `the ${method} gateway call`) as Record<string, unknown>;
  };

  // 4. The plugin loads and the host reports it as a page provider.
  const inspect = parseHostJson(await oc(["plugins", "inspect", "oc-family-pack", "--json"], env, "plugin load"), "plugin load", "plugins inspect") as {
    plugin?: { status?: string; uiCapabilities?: string[] };
  };
  const plugin = inspect.plugin ?? (inspect as { status?: string; uiCapabilities?: string[] });
  if (plugin.status !== "loaded") fail("plugin load", `plugin status is ${plugin.status}, expected loaded`);
  note("plugin loaded", "plugin load");

  // 5. The week over the real transport, validated against the contract schema.
  // The token CLI is the owner, so this is the whole household.
  const weekCall = await call(WEEK_METHOD, {}, "contract validation");
  const schemaErrors = [...Value.Errors(WeekPayloadSchema, weekCall as never)].slice(0, 3) as {
    path?: string;
    message: string;
  }[];
  if (schemaErrors.length) {
    fail(
      "contract validation",
      `payload does not match the contract schema: ${schemaErrors.map((e) => `${e.path ?? "/"} ${e.message}`).join("; ")}`,
    );
  }
  note("family.week result validates against the contract schema", "contract validation");

  const week = weekCall as { days: unknown[]; members: unknown[]; mode: string };
  if (week.days.length !== 7) fail("family.week query", `expected 7 days, got ${week.days.length}`);
  if (week.mode !== "demo") fail("family.week query", `expected demo mode against an isolated Gateway, got ${week.mode}`);
  if (week.members.length === 0) fail("family.week query", "family.week returned no members");
  note(`family.week returned ${week.members.length} members over 7 days in ${week.mode} mode`, "family.week query");

  // 6. The native page: capabilities advertised and the built assets present.
  for (const capability of ["page", "navigation"]) {
    if (!(plugin.uiCapabilities ?? []).includes(capability)) {
      fail("page registration", `uiCapabilities does not advertise ${capability}`);
    }
  }
  // Read the manifest and assets from the root the host actually loaded, not
  // from the working tree, so a stale local dist/ cannot make a broken install
  // look fine. `plugins inspect` is the authority on where that root is; a
  // --link install records the path in plugins.load.paths rather than copying
  // into the state dir, so do not assume a layout.
  const inspectRecord2 = parseHostJson(
    await oc(["plugins", "inspect", "oc-family-pack", "--json"], env, "page registration"),
    "page registration",
    "plugins inspect",
  ) as {
    plugin?: { rootDir?: string };
  };
  const installedRoot = (inspectRecord2.plugin ?? (inspectRecord2 as { rootDir?: string })).rootDir;
  if (!installedRoot) {
    fail("page registration", "the host did not report a root directory for the installed plugin");
  }
  const manifestPath = join(installedRoot, "openclaw.plugin.json");
  if (!existsSync(manifestPath)) {
    fail("page registration", `the host reported root ${installedRoot} but it has no openclaw.plugin.json`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    controlUi?: { entry?: string; styles?: string[] };
  };
  for (const asset of [manifest.controlUi?.entry, ...(manifest.controlUi?.styles ?? [])]) {
    if (!asset) fail("page registration", "manifest controlUi entry is missing");
    try {
      readFileSync(join(installedRoot, asset));
    } catch {
      fail("page registration", `installed Control UI asset ${asset} is missing from the root the host loaded`);
    }
  }
  note(`page registered, built assets present in the installed root`, "page registration");

  // 7. The scheduler surface the briefs will register jobs on. The plugin's
  // store is a service, not a cron job, so this only checks that the host
  // scheduler answers. The real job check lands with the briefs epic.
  const jobs = await call("cron.list", {}, "service scheduler");
  if (!Array.isArray(jobs.jobs)) fail("service scheduler", "cron.list did not return a jobs array");
  note(`host scheduler surface answers (${jobs.jobs.length} host jobs); the store is a service, and briefs register jobs later`, "service scheduler");

  // 8. The plugin-owned store. The service opens the real database, applies
  // 0001-initial to 0004-reminder-mode, and leaves those rows in place across a Gateway restart, a
  // forced reinstall, and plugins update. Backup must snapshot it instead of
  // archiving it as opaque bytes. A store that cannot open must not take the Gateway down.
  const pluginStateDir = join(stateDir, "plugins", PLUGIN_ID);
  const opened = await waitForStore(stateDir);
  assertStoreModes(opened);
  const firstRows = readMigrations(opened);
  if (firstRows.map((row) => row.id).join(",") !== "0001-initial,0002-write-log,0003-delivery-log,0004-reminder-mode") {
    fail("sqlite store", `expected 0001-initial through 0004-reminder-mode, got ${JSON.stringify(firstRows)}`);
  }
  const logsBlocked = readLogGuards(opened);
  if (logsBlocked.join(",") !== "write update,write delete,delivery update,delivery delete,reminder update,reminder delete") {
    fail("sqlite store", `the logs are not append-only in the Gateway's database: ${JSON.stringify(logsBlocked)}`);
  }
  note("0002-write-log through 0004-reminder-mode are applied, and both logs refuse UPDATE and DELETE", "sqlite store");
  const appliedAt = firstRows[0]?.applied_at ?? 0;
  const readyLine = stripAnsi(readFileSync(logPath, "utf8"))
    .split("\n")
    .find((line) => line.includes("oc-family-pack store ready"));
  if (!readyLine) fail("sqlite store", "the store did not log ready");
  note(readyLine.trim(), "sqlite store");
  const hostDb = join(stateDir, "state", "openclaw.sqlite");
  const strays = stateFiles(stateDir).filter(
    (full) =>
      (full.endsWith(".sqlite") || full.endsWith(".db")) &&
      !full.startsWith(pluginStateDir) &&
      full !== hostDb &&
      full.toLowerCase().includes(PLUGIN_ID),
  );
  if (strays.length) {
    fail(
      "sqlite store",
      `plugin-owned state appeared outside ${pluginStateDir}: ${strays.map((s) => s.slice(stateDir.length + 1)).join(", ")}`,
    );
  }
  note(`0001-initial applied at ${appliedAt}, directory 0700, database and WAL sidecars 0600`, "sqlite store");

  await bootGateway(env, port, logPath);
  const reopened = await waitForStore(stateDir);
  assertStoreModes(reopened);
  const secondRows = readMigrations(reopened);
  if (secondRows[0]?.id !== "0001-initial" || secondRows[0]?.applied_at !== appliedAt) {
    fail("sqlite store", `restart changed the 0001 row: ${JSON.stringify(secondRows)}`);
  }
  note("0001-initial survived a Gateway restart and was not applied again", "sqlite store");

  await stopGateway();
  await oc(["plugins", "install", sourceDir, "--force", "--link", "--accept-capabilities"], env, "sqlite store");
  await bootGateway(env, port, logPath);
  const afterInstall = readMigrations(await waitForStore(stateDir));
  if (afterInstall[0]?.id !== "0001-initial" || afterInstall[0]?.applied_at !== appliedAt) {
    fail("sqlite store", `reinstall changed the 0001 row: ${JSON.stringify(afterInstall)}`);
  }
  note("0001-initial survived plugins install --force", "sqlite store");

  await stopGateway();
  const updated = await oc(["plugins", "update", "oc-family-pack"], env, "sqlite store");
  await bootGateway(env, port, logPath);
  const afterUpdate = readMigrations(await waitForStore(stateDir));
  if (afterUpdate[0]?.id !== "0001-initial" || afterUpdate[0]?.applied_at !== appliedAt) {
    fail("sqlite store", `plugins update changed the 0001 row: ${JSON.stringify(afterUpdate)}`);
  }
  note(`plugins update skips path installs and left 0001-initial alone (${updated.trim().split("\n")[0] ?? "no output"})`, "sqlite store");

  const backupRaw = await oc(
    ["backup", "create", "--verify", "--json", "--output", join(workDir, "backups")],
    env,
    "sqlite store",
  );
  const backup = parseHostJson(backupRaw, "sqlite store", "backup create") as { warnings?: unknown };
  const warnings = Array.isArray(backup.warnings) ? backup.warnings.map((warning) => String(warning)) : [];
  const opaque = warnings.filter((warning) => /opaque/i.test(warning) && warning.includes(PLUGIN_ID));
  if (opaque.length) fail("sqlite store", `backup archived the family database as opaque bytes: ${opaque.join(" | ")}`);
  note(
    warnings.length ? `backup create --verify warnings: ${warnings.join(" | ")}` : "backup create --verify reported no warnings",
    "sqlite store",
  );

  // A real startup failure, not a hook: the store directory's path is a plain
  // file, so the worker's mkdir throws. The Gateway must stay up, keep serving
  // family.week, and show the service as failed. The journal fault and a fault
  // during a call are unit tests in src/store.test.ts.
  await stopGateway();
  const heldDir = `${pluginStateDir}.held`;
  renameSync(pluginStateDir, heldDir);
  writeFileSync(pluginStateDir, "");
  await bootGateway(env, port, logPath);
  if (gateway?.exitCode !== null && gateway?.exitCode !== undefined) {
    fail("sqlite store", "the isolated Gateway exited when the store could not open");
  }
  const blockedLog = stripAnsi(readFileSync(logPath, "utf8"));
  if (!blockedLog.includes("oc-family-pack: family store worker failed")) {
    fail("sqlite store", "the store failure was not in the Gateway log");
  }
  const listed = await call("plugins.list", {}, "sqlite store");
  const entry = (listed.plugins as Array<{ id?: string; runtime?: { state?: string; error?: string } }> | undefined)?.find(
    (plugin) => plugin.id === PLUGIN_ID,
  );
  if (entry?.runtime?.state !== "service-failed" || !entry.runtime.error?.startsWith("family-store:")) {
    fail("sqlite store", `reportFailure did not reach the host: ${JSON.stringify(entry?.runtime)}`);
  }
  const duringFailure = await call(WEEK_METHOD, {}, "sqlite store");
  if ((duringFailure.days as unknown[] | undefined)?.length !== 7) fail("sqlite store", "family.week failed while the store could not open");
  note(`Gateway kept serving family.week with the store blocked; plugins.list shows ${entry.runtime.error}`, "sqlite store");

  await stopGateway();
  rmSync(pluginStateDir);
  renameSync(heldDir, pluginStateDir);
  await bootGateway(env, port, logPath);
  const afterFailure = readMigrations(await waitForStore(stateDir));
  if (afterFailure[0]?.id !== "0001-initial" || afterFailure[0]?.applied_at !== appliedAt) {
    fail("sqlite store", `the 0001 row changed after the blocked start: ${JSON.stringify(afterFailure)}`);
  }
  const weekAfterFault = await call(WEEK_METHOD, {}, "sqlite store");
  if ((weekAfterFault.days as unknown[] | undefined)?.length !== 7) fail("sqlite store", "family.week failed after the store came back");
  note("store reopened with the same 0001 row once the path was a directory again", "sqlite store");

  // 9. Our host-limit arithmetic must agree with the host's own counter, so a
  // host change to those limits fails here instead of rotting the contract comment.
  const isHostJson = await loadHostJsonCheck();
  const demo = await buildWeekPayload(
    parseConfig({ demo: true, timezone: "America/Toronto" }),
    undefined,
    Date.now(),
    async () => ({ status: "unconfigured", hint: "x" }),
    { kind: "owner" },
  );
  const boundary: [string, unknown][] = [
    ["the demo week", demo],
    ["4094 strings (under maxNodes)", { list: Array.from({ length: 4094 }, () => "x") }],
    ["4095 strings (over maxNodes)", { list: Array.from({ length: 4095 }, () => "x") }],
    ["five strings over the byte limit", Array.from({ length: 5 }, () => "a".repeat(52_430))],
  ];
  for (const [name, value] of boundary) {
    if (fitsHostLimits(value) !== isHostJson(value)) {
      fail(
        "host json limits",
        `fitsHostLimits disagrees with the host on ${name} (${jsonNodeCount(value)} nodes); re-derive HOST_MAX_NODES in src/payload.ts`,
      );
    }
  }
  note(`host json limits agree with the host on ${boundary.length} payloads (MAX_WEEK_EVENTS ${MAX_WEEK_EVENTS})`, "host json limits");

  // 10. The update path an operator runs after a host upgrade. This install is
  // a local --link, so `plugins update` structurally reports it as skipped; a
  // bare "produced output" assertion would pass no matter what. Assert the real
  // outcome instead: the host must recognise the plugin and explain the skip,
  // and it must be skipping for the link reason rather than failing to resolve.
  const dryRun = await oc(["plugins", "update", "oc-family-pack", "--dry-run"], env, "update path");
  const resolved = dryRun.trim();
  if (!resolved) fail("update path", "'plugins update --dry-run' produced no output for a linked install");
  if (!/skip|up to date|path|link|no changes|nothing to update/i.test(resolved)) {
    fail("update path", `'plugins update --dry-run' did not resolve the linked install: ${resolved.slice(0, 300)}`);
  }
  if (/error|fail|cannot|unable/i.test(resolved)) {
    fail("update path", `'plugins update --dry-run' reported a problem: ${resolved.slice(0, 300)}`);
  }
  note(`plugins update resolves this install: ${resolved.split("\n")[0]}`, "update path");

  // A real household installs from git, where `openclaw update` does refresh the
  // plugin. A --link install cannot exercise that, so this only proves the host
  // records a source it could resolve later; the git refresh itself is covered
  // by the operator's own git install, not here.
  const inspectRecord = parseHostJson(
    await oc(["plugins", "inspect", "oc-family-pack", "--json"], env, "update path"),
    "update path",
    "plugins inspect",
  ) as {
    plugin?: { source?: string; installPath?: string | null };
  };
  const record = inspectRecord.plugin ?? (inspectRecord as { source?: string });
  if (!record.source) fail("update path", "the installed plugin has no recorded source, so updates cannot be resolved");
  note(`install source recorded as ${record.source}`, "update path");

  await deviceTokenOwner(port, TOKEN);
  await householdSignIn(env, configPath, port, logPath);
  const garbage = await garbageFeed();
  await calendarWatch(env, configPath, port, logPath, garbage.url);
  await scheduleTool(configPath, port);
  await garbageTool(port, garbage);
}

/** Stand-ins for what a real household fills in, used only on this isolated Gateway. */
const HOUSEHOLD_ADDRESS = "192.168.1.20";
const HOUSEHOLD_CLIENT = "192.168.1.50";
const HOUSEHOLD_PASSWORD = "ocfp-smoke-password";

type Frame = { method: string; ok: boolean; payload?: Record<string, unknown> | undefined; error?: { code?: string; message?: string; details?: { code?: string } } | undefined };

type ConnectParams = Record<string, unknown>;

/**
 * Opens a WebSocket to the isolated Gateway with `headers`, answers the
 * connect challenge with `connect(nonce)`, then runs `calls` in order and stops
 * at the first failure. Node's built-in WebSocket takes request headers as a
 * non-standard `headers` option.
 */
function session(port: number, who: string, headers: Record<string, string>, connect: (nonce: string) => ConnectParams, calls: [string, unknown][]): Promise<Frame[]> {
  const step: Step = "household sign-in";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers } as unknown as string[]);
    const frames: Frame[] = [];
    const methods = new Map<string, string>();
    const queue = [...calls];
    let id = 0;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`smoke: ${step} failed: ${who}'s session timed out after ${JSON.stringify(frames)}`));
    }, 30_000);
    const send = (method: string, params: unknown) => {
      const key = String(++id);
      methods.set(key, method);
      ws.send(JSON.stringify({ type: "req", id: key, method, params }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string; ok?: boolean; payload?: Record<string, unknown>; error?: Frame["error"] };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        send("connect", connect(String(frame.payload?.nonce ?? "")));
        return;
      }
      if (frame.type !== "res" || frame.id === undefined) return;
      frames.push({ method: methods.get(frame.id) ?? "?", ok: frame.ok === true, payload: frame.payload, error: frame.error });
      const next = queue.shift();
      if (frame.ok === true && next) send(next[0], next[1]);
      else ws.close();
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(frames);
    };
  });
}

const CONTROL_UI_CLIENT = { id: "openclaw-control-ui", version: "ocfp-smoke", platform: process.platform, mode: "ui" };
const OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.sessions.write"];

/**
 * Connects the way a browser behind the household proxy does: from loopback,
 * with the proxy's client-address header, the page's origin and, unless `user`
 * is null, the proxy's identity header.
 */
function proxiedSession(port: number, user: string | null, calls: [string, unknown][]): Promise<Frame[]> {
  const headers: Record<string, string> = { origin: `https://${HOUSEHOLD_ADDRESS}`, "x-forwarded-for": HOUSEHOLD_CLIENT };
  if (user !== null) headers["x-forwarded-user"] = user;
  return session(port, user ?? "no user header", headers, () => ({
    minProtocol: 4,
    maxProtocol: 4,
    client: CONTROL_UI_CLIENT,
    role: "operator",
    scopes: OPERATOR_SCOPES,
    caps: [],
  }), calls);
}

/** A browser's device key pair, signed the way the Control UI signs its connect (v3 device payload). */
function deviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const id = createHash("sha256").update(raw).digest("hex");
  const sign = (nonce: string, token: string) => {
    const signedAt = Date.now();
    const payload = ["v3", id, CONTROL_UI_CLIENT.id, CONTROL_UI_CLIENT.mode, "operator", OPERATOR_SCOPES.join(","), String(signedAt), token, nonce, process.platform.toLowerCase(), ""].join("|");
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
    return { id, publicKey: raw.toString("base64url"), signature, signedAt, nonce };
  };
  return { sign };
}

/** The owner's Control UI on loopback, signing in with `auth` and a device key. */
function ownerBrowserSession(
  port: number,
  device: ReturnType<typeof deviceIdentity>,
  auth: { token?: string; deviceToken?: string },
  buildId: string | undefined,
  calls: [string, unknown][],
): Promise<Frame[]> {
  return session(port, "owner browser", { origin: `http://127.0.0.1:${port}` }, (nonce) => ({
    minProtocol: 4,
    maxProtocol: 4,
    client: { ...CONTROL_UI_CLIENT, buildId },
    role: "operator",
    scopes: OPERATOR_SCOPES,
    caps: [],
    auth,
    device: device.sign(nonce, auth.token ?? auth.deviceToken ?? ""),
  }), calls);
}

/**
 * 10b. The token owner's browser gets a device token and, coming back on that
 * device token alone, still reads as the owner: family.week holds every calendar.
 */
async function deviceTokenOwner(port: number, token: string): Promise<void> {
  const step: Step = "household sign-in";
  const device = deviceIdentity();
  // A same-origin Control UI must send the Gateway's build id, which the page it
  // loaded carries. The Gateway names it when it refuses a connect without one.
  const probe = await ownerBrowserSession(port, device, { token }, undefined, []);
  const buildId = (probe[0]?.error?.details as { gatewayBuildId?: string } | undefined)?.gatewayBuildId;
  if (!buildId) fail(step, `could not learn the Gateway's Control UI build id: ${JSON.stringify(probe)}`);
  const first = await ownerBrowserSession(port, device, { token }, buildId, []);
  const deviceToken = (first[0]?.payload?.auth as { deviceToken?: string } | undefined)?.deviceToken;
  if (!first[0]?.ok || !deviceToken) fail(step, `the owner's browser got no device token on the shared token: ${JSON.stringify(first[0]?.error ?? first[0]?.payload?.auth ?? first)}`);
  const back = await ownerBrowserSession(port, device, { deviceToken }, buildId, [[WEEK_METHOD, {}]]);
  if (!back[0]?.ok) fail(step, `the owner's browser could not come back on its device token: ${JSON.stringify(back[0]?.error ?? back)}`);
  const calendars = (back[1]?.payload as { calendars?: { label: string }[] } | undefined)?.calendars;
  const sees = (calendars ?? []).map((calendar) => calendar.label).sort().join(", ");
  if (!back[1]?.ok || sees !== "Alex, Family, Jordan, Riley, Sam, School") {
    fail(step, `the owner on a device token should see every calendar, got ${JSON.stringify(back[1]?.error ?? sees)}`);
  }
  note("the token owner's browser, back on its device token alone, gets family.week with all six calendars", step);
}

/**
 * 11. Per-person sign-in, configured exactly as `openclaw family access lan`
 * prints it, with the placeholders filled in. No proxy is installed: this
 * process plays the proxy from loopback, which the printed config trusts.
 * Runs last because it switches the isolated Gateway off token auth.
 */
async function householdSignIn(env: NodeJS.ProcessEnv, configPath: string, port: number, logPath: string): Promise<void> {
  const step: Step = "household sign-in";
  const printed = planAccess("lan", { parent: ["alex"], kid: ["riley"] }, { port }).text.replaceAll("LAN_ADDRESS", HOUSEHOLD_ADDRESS);
  const [access, roles] = [...printed.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map(
    (match) => (JSON.parse(match[0]) as { gateway: Record<string, unknown> & { auth: Record<string, unknown> } }).gateway,
  );
  if (!access || !roles) fail(step, "access lan did not print the Gateway config and roles blocks");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { gateway: Record<string, unknown> };
  config.gateway = {
    mode: "local",
    port,
    ...access,
    auth: { ...access.auth, ...roles.auth, password: HOUSEHOLD_PASSWORD },
    roles: roles.roles,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  await bootGateway(env, port, logPath);
  note(`isolated Gateway restarted with the printed LAN config, signing in through ${HOUSEHOLD_ADDRESS}`, step);

  const connected = (frames: Frame[], who: string): Frame => {
    const hello = frames[0];
    if (!hello?.ok) fail(step, `${who} could not sign in: ${JSON.stringify(hello?.error ?? frames)}`);
    return hello;
  };
  const scopesOf = (hello: Frame) => (((hello.payload?.auth as { scopes?: string[] } | undefined)?.scopes ?? []) as string[]).slice().sort();
  const week = [WEEK_METHOD, {}] as [string, unknown];

  const alex = await proxiedSession(port, "alex", [["users.self", {}], week]);
  const riley = await proxiedSession(port, "riley", [["users.self", {}], week]);
  connected(alex, "alex");
  const rileyHello = connected(riley, "riley");
  const profileOf = (frames: Frame[], who: string) => {
    const profile = (frames[1]?.payload?.profile ?? {}) as { id?: string; displayName?: string };
    if (!frames[1]?.ok || profile.displayName !== who || !profile.id) fail(step, `users.self for ${who} returned ${JSON.stringify(frames[1] ?? frames)}`);
    return profile.id;
  };
  const alexId = profileOf(alex, "alex");
  const rileyId = profileOf(riley, "riley");
  if (alexId === rileyId) fail(step, `alex and riley share profile ${alexId}`);
  note("alex and riley each signed in to their own profile", step);

  if (JSON.stringify(scopesOf(rileyHello)) !== JSON.stringify(["operator.read"])) {
    fail(step, `a new member should be a read-only guest, got ${JSON.stringify(scopesOf(rileyHello))}`);
  }
  // The demo roster has alex as a parent and riley as a kid. Each label list is what that person's week shows.
  const shownTo = (frames: Frame[], who: string) => {
    const frame = frames[2];
    const calendars = (frame?.payload as { calendars?: { label: string }[]; days?: unknown[] } | undefined)?.calendars;
    if (!frame?.ok || !calendars) fail(step, `${who}'s family.week did not get through on operator.read: ${JSON.stringify(frame ?? frames)}`);
    return calendars.map((calendar) => calendar.label).sort().join(", ");
  };
  const rileySees = shownTo(riley, "riley");
  if (rileySees !== "Family, Riley, School") fail(step, `riley's family.week should hold Family, Riley and School only, got ${rileySees}`);
  const alexSees = shownTo(alex, "alex");
  if (alexSees !== "Alex, Family, Jordan, Riley, Sam, School") fail(step, `alex's family.week should hold every calendar, got ${alexSees}`);
  note(`riley, a guest on operator.read, gets family.week with ${rileySees}; alex gets all six calendars`, step);

  // A proxied session with no username would read as the owner, since
  // trusted-proxy is shared Gateway auth. The host must refuse it at connect.
  for (const user of [null, "", "   "]) {
    const frames = await proxiedSession(port, user, [week]);
    if (frames[0]?.ok !== false || frames.length !== 1) {
      fail(step, `a proxied session with user header ${JSON.stringify(user)} got through: ${JSON.stringify(frames)}`);
    }
    note(`a proxied session with user header ${JSON.stringify(user)} is refused at connect: ${frames[0].error?.details?.code ?? frames[0].error?.message}`, step);
  }

  const cli = async (method: string, params: unknown) =>
    parseHostJson(
      await oc(["gateway", "call", method, "--port", String(port), "--json", "--params", JSON.stringify(params)], env, step),
      step,
      `the ${method} gateway call`,
    ) as { profiles?: { id: string; displayName: string }[]; profile?: { role?: string } };
  // The local CLI signs in with the household password: shared Gateway auth with no user, so the owner.
  const ownerWeek = (await cli(WEEK_METHOD, {})) as { calendars?: { label: string }[] };
  const ownerSees = (ownerWeek.calendars ?? []).map((calendar) => calendar.label).sort().join(", ");
  if (ownerSees !== "Alex, Family, Jordan, Riley, Sam, School") fail(step, `the password CLI's family.week should hold every calendar, got ${ownerSees}`);
  note("the password CLI, the household owner, gets family.week with all six calendars", step);
  const listed = (await cli("users.list", {})).profiles ?? [];
  const listedAlex = listed.find((profile) => profile.displayName === "alex")?.id;
  if (listedAlex !== alexId) fail(step, `users.list does not show alex as ${alexId}: ${JSON.stringify(listed)}`);
  const set = await cli("users.setRole", { profileId: alexId, role: "parent" });
  if (set.profile?.role !== "parent") fail(step, `users.setRole did not make alex a parent: ${JSON.stringify(set)}`);
  const alexAgain = connected(await proxiedSession(port, "alex", []), "alex after setRole");
  if (!scopesOf(alexAgain).includes("operator.write")) {
    fail(step, `alex has no operator.write after users.setRole parent: ${JSON.stringify(scopesOf(alexAgain))}`);
  }
  note(`users.setRole made alex a parent: ${scopesOf(alexAgain).join(", ")}`, step);
  // alex now holds operator.write, so a refusal here can only mean the action is gone.
  const oldWeek = (await proxiedSession(port, "alex", [["plugins.sessionAction", { pluginId: PLUGIN_ID, actionId: "family.week", payload: {} }]]))[1];
  const oldResult = oldWeek?.payload as { ok?: boolean } | undefined;
  if (!oldWeek || (oldWeek.ok && oldResult?.ok !== false) || /scope/i.test(oldWeek.error?.message ?? "")) {
    fail(step, `the old family.week session action still answered, or was refused for scope only: ${JSON.stringify(oldWeek)}`);
  }
  note(`the old family.week session action is gone: ${oldWeek.error?.message ?? JSON.stringify(oldWeek.payload)}`, step);

  // Send the link line setup prints for a Discord ID exactly as printed, with
  // alex's real profile id in place of the placeholder.
  const discordId = "100000000000000001";
  const setupText = planSetup(
    { gateway: config.gateway, plugins: { entries: { [PLUGIN_ID]: { config: { members: [{ profileId: "alex", displayName: "Alex", role: "parent" }] } } } } },
    { discord: [`alex=${discordId}`] },
    { status: "ready", command: "", message: "" },
    "UTC",
  ).text;
  const linkLine = /^openclaw gateway call users\.linkChannelIdentity --params '(.*)'$/m.exec(setupText)?.[1];
  if (!linkLine) fail(step, `setup printed no Discord link line in LAN mode:\n${setupText}`);
  await cli("users.linkChannelIdentity", JSON.parse(linkLine.replace("PROFILE_alex", alexId)));
  const links = ((await cli("users.listChannelIdentities", { profileId: alexId })) as { links?: { identity?: Record<string, string> }[] }).links ?? [];
  if (!links.some((link) => link.identity?.channelId === "discord" && link.identity.senderId === discordId)) {
    fail(step, `the printed link did not tie Discord ${discordId} to alex: ${JSON.stringify(links)}`);
  }
  note(`setup's printed link tied Discord ${discordId} to alex's profile (account ${links[0]?.identity?.accountId})`, step);

  const stranger = (await proxiedSession(port, "mallory", []))[0];
  // Her headers match alex's apart from the username. Pin the refusal so a
  // different failure can't pass for an allowUsers refusal.
  const refusal = stranger?.error?.details?.code;
  if (stranger?.ok !== false || refusal !== "CONTROL_UI_DEVICE_IDENTITY_REQUIRED") {
    fail(step, `mallory is not in allowUsers and should be refused with CONTROL_UI_DEVICE_IDENTITY_REQUIRED: ${JSON.stringify(stranger)}`);
  }
  note(`mallory, not in allowUsers, was turned away (${refusal})`, step);
}

/**
 * Opens a session as `user` behind the household proxy and waits until every
 * name in `events` has arrived as a broadcast event frame. `ready` runs once the
 * session is signed in, so nothing it triggers can land before we listen.
 */
function awaitEvents(port: number, user: string, events: string[], timeoutMs: number, ready: () => Promise<void>): Promise<Map<string, unknown>> {
  const step: Step = "calendar watch";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: `https://${HOUSEHOLD_ADDRESS}`, "x-forwarded-for": HOUSEHOLD_CLIENT, "x-forwarded-user": user } } as unknown as string[]);
    const seen = new Map<string, unknown>();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(seen);
    };
    const timer = setTimeout(() => finish(new Error(`smoke: ${step} failed: no ${events.filter((name) => !seen.has(name)).join(" or ")} within ${timeoutMs / 1000}s`)), timeoutMs);
    ws.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as { type: string; event?: string; ok?: boolean; payload?: unknown; error?: unknown };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        ws.send(JSON.stringify({ type: "req", id: "1", method: "connect", params: { minProtocol: 4, maxProtocol: 4, client: CONTROL_UI_CLIENT, role: "operator", scopes: OPERATOR_SCOPES, caps: [] } }));
        return;
      }
      if (frame.type === "res") {
        if (frame.ok !== true) finish(new Error(`smoke: ${step} failed: ${user} could not sign in: ${JSON.stringify(frame.error)}`));
        else ready().catch((error: Error) => finish(error));
        return;
      }
      if (frame.type === "event" && frame.event && events.includes(frame.event) && !seen.has(frame.event)) {
        seen.set(frame.event, frame.payload);
        if (seen.size === events.length) finish();
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => finish(new Error(`smoke: ${step} failed: ${user}'s session closed before ${events.join(" and ")} arrived`));
  });
}

/**
 * 12. Change detection on the real host: a roster calendar backed by a stand-in
 * gog in the temp dir. The service takes its baseline at start, the stand-in
 * then reports a newer edit, and the next poll must reach a signed-in page as
 * plugin events. No Google call and no real gog: gogPath is the stand-in.
 * Waits one poll interval, since the interval is deliberately not configurable.
 * The config also points garbageIcsUrl at step 14's stand-in city calendar.
 */
async function calendarWatch(env: NodeJS.ProcessEnv, configPath: string, port: number, logPath: string, garbageIcsUrl: string): Promise<void> {
  const step: Step = "calendar watch";
  const dir = join(dirname(configPath), "gog");
  mkdirSync(dir);
  const calls = join(dir, "calls.log");
  const edited = join(dir, "edited");
  const gogPath = join(dir, "gog");
  writeFileSync(
    gogPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case "$1 $2" in',
      '  "calendar changed")',
      `    if [ -e '${edited}' ]; then updated=2026-10-03T12:05:00.123Z; else updated=2026-10-03T12:00:00.000Z; fi`,
      `    printf '{"events":[{"id":"ocfp-smoke","updated":"%s"}],"since":"2026-09-03T12:00:00Z"}\\n' "$updated" ;;`,
      `  "calendar events") if [ -e '${dir}/events.json' ]; then cat '${dir}/events.json'; else printf '{"events":[]}\\n'; fi ;;`,
      `  *) printf '{"events":[]}\\n' ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(gogPath, 0o700);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { plugins: { entries: Record<string, { enabled: boolean; config: unknown }> } };
  const calendarId = "family@example.com";
  config.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    config: {
      timezone: "America/Toronto",
      gogPath,
      members: [{ profileId: "alex", displayName: "Alex", role: "parent" }],
      calendars: [{ id: calendarId, label: "Family", kind: "shared" }],
      garbageIcsUrl,
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const started = Date.now();
  await bootGateway(env, port, logPath);
  note(`isolated Gateway restarted with one roster calendar read through a stand-in gog`, step);

  const changedEvent = `plugin.${PLUGIN_ID}.calendar-changed`;
  const checkedEvent = `plugin.${PLUGIN_ID}.calendar-checked`;
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("calendar changed")) : []);
  const got = await awaitEvents(port, "alex", [changedEvent, checkedEvent], POLL_MS + 90_000, async () => {
    for (let waited = 0; readCalls().length === 0; waited += 250) {
      if (waited > 30_000) fail(step, "the service took no baseline read within 30s of start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    writeFileSync(edited, "");
    note("baseline read taken at start; the stand-in now reports a newer edit", step);
  });
  const changed = got.get(changedEvent) as { reason?: string; calendarKeys?: unknown[]; at?: string } | undefined;
  if (changed?.reason !== "external" || changed.calendarKeys?.length !== 0 || !Number.isFinite(Date.parse(changed.at ?? ""))) {
    fail(step, `calendar-changed carried ${JSON.stringify(changed)}, expected { reason: "external", calendarKeys: [], at }`);
  }
  if (JSON.stringify(got.get(checkedEvent)) !== "{}") fail(step, `calendar-checked carried ${JSON.stringify(got.get(checkedEvent))}, expected {}`);
  const [first, second] = readCalls();
  const expected = (since: string) => `calendar changed --since ${since} --max 1 --json --no-input -- ${calendarId}`;
  if (first !== expected("720h") || second !== expected("2026-10-03T12:00:00.000Z")) {
    fail(step, `gog was called as ${JSON.stringify([first, second])}`);
  }
  note(`a signed-in page got calendar-changed and calendar-checked ${Math.round((Date.now() - started) / 1000)}s after start; the second poll asked gog for edits since the baseline`, step);
}

/**
 * 13. The agent tool on the real host, still on the calendar-watch Gateway and
 * its stand-in gog: today's one-off lands under "not the usual" and the
 * on-time repeat in the usual line. The shared password is the owner. A caller
 * claiming Discord carries no roster sender id, so "me" is refused.
 */
/** Calls an agent tool over the Gateway's HTTP tools endpoint as the household owner. */
async function invokeTool(step: Step, port: number, tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOUSEHOLD_PASSWORD}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ tool, args }),
  });
  const text = await response.text();
  if (!response.ok) fail(step, `/tools/invoke answered ${response.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as { ok?: boolean; result?: { details?: unknown; content?: { type: string; text?: string }[] } };
  const result = body.result?.details ?? JSON.parse(body.result?.content?.find((part) => part.type === "text")?.text ?? "null");
  return result as Record<string, unknown>;
}

async function scheduleTool(configPath: string, port: number): Promise<void> {
  const step: Step = "family_schedule tool";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(Date.now());
  const swim = `${today}T21:00:00Z`;
  writeFileSync(
    join(dirname(configPath), "gog", "events.json"),
    JSON.stringify({
      events: [
        { id: "dentist", summary: "Dentist", start: { dateTime: `${today}T16:00:00Z` }, end: { dateTime: `${today}T17:00:00Z` } },
        { id: "swim_1", summary: "Swim", start: { dateTime: swim }, end: { dateTime: `${today}T22:00:00Z` }, recurringEventId: "swim", originalStartTime: { dateTime: swim } },
      ],
    }),
  );
  const invoke = (args: Record<string, unknown>, headers: Record<string, string> = {}) => invokeTool(step, port, "family_schedule", args, headers);
  const owner = await invoke({});
  const expected = { sections: [{ name: "not the usual", items: [{ id: "c0/dentist", title: "Dentist", time: "12:00 PM", owners: [] }] }], usual: "Usual: Swim 5:00 PM" };
  if (JSON.stringify(owner) !== JSON.stringify(expected)) fail(step, `family_schedule returned ${JSON.stringify(owner)}, expected ${JSON.stringify(expected)}`);
  note("the agent tool, called with the shared password, put Dentist (with the id the change tools take) under not the usual and Swim in the usual line", step);
  const claimed = await invoke({ member: "me" }, { "x-openclaw-message-channel": "discord" });
  if (JSON.stringify(claimed) !== JSON.stringify({ error: "I can't tell who 'me' is here. Name the person." })) {
    fail(step, `a Discord caller with no roster sender id asked for "me" and got ${JSON.stringify(claimed)}`);
  }
  note('a caller claiming Discord with no roster sender id asking for "me" got the refusal and no events', step);
}

/**
 * A stand-in city collection calendar, served from this process: garbage tomorrow, recycling
 * in eight days, and a depot day that is not curbside. Dates follow the smoke's Toronto zone.
 */
async function garbageFeed(): Promise<{ url: string; today: string; hits: () => number }> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(Date.now());
  const day = (offset: number) => addDays(today, offset).replaceAll("-", "");
  const event = (offset: number, summary: string) => ["BEGIN:VEVENT", `DTSTART;VALUE=DATE:${day(offset)}`, `SUMMARY:${summary}`, "END:VEVENT"];
  const body = ["BEGIN:VCALENDAR", ...event(8, "Recycling and Green Cart"), ...event(1, "Garbage and Green Cart"), ...event(3, "Depot Drop-off Day"), "END:VCALENDAR", ""].join("\r\n");
  let hits = 0;
  const server = createHttpServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/calendar" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/places/PLACE-4242/events.en.ics`, today, hits: () => hits };
}

/** 14. The garbage_schedule tool on the same Gateway reads the stand-in calendar: curbside pickups only, no link or place id. */
async function garbageTool(port: number, feed: { today: string; hits: () => number }): Promise<void> {
  const step: Step = "garbage_schedule tool";
  const label = (offset: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "2-digit" })
        .formatToParts(Date.parse(`${addDays(feed.today, offset)}T12:00:00Z`))
        .map((part) => [part.type, part.value]),
    );
    return `${parts.weekday}, ${parts.month} ${parts.day}`;
  };
  const answer = await invokeTool(step, port, "garbage_schedule", {});
  const expected = { collections: [{ date: label(1), what: "Garbage and Green Bin" }, { date: label(8), what: "Green Bin and Recycling" }] };
  if (JSON.stringify(answer) !== JSON.stringify(expected)) fail(step, `garbage_schedule returned ${JSON.stringify(answer)}, expected ${JSON.stringify(expected)}`);
  if (/127\.0\.0\.1|PLACE|ics/.test(JSON.stringify(answer))) fail(step, `garbage_schedule leaked the feed link: ${JSON.stringify(answer)}`);
  if (feed.hits() < 1) fail(step, "the stand-in calendar was never fetched");
  note(`garbage_schedule read the stand-in city calendar (${feed.hits()} fetch): garbage tomorrow and recycling in eight days, the depot day left out, no link in the reply`, step);
}

try {
  await main();
  // A cancelled run must never report success. Every step boundary already
  // refuses to continue, so reaching here with a pending interrupt means the
  // signal landed in the last step; still fail, naming what was interrupted.
  if (interrupted) throw new Error(`smoke: household sign-in failed: interrupted by ${interrupted} after the last step`);
  process.stdout.write("smoke: all steps passed\n");
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await stopGateway();
  if (workDir && !keepWorkDir) {
    // The isolated Gateway can still be flushing logs after SIGTERM, so retry
    // briefly rather than leave temp state behind.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (existsSync(workDir)) process.stderr.write(`smoke: could not remove ${workDir}\n`);
  } else if (workDir) {
    process.stderr.write(`smoke: kept ${workDir}\n`);
  }
  // A killed child's stdio sockets can linger in the handle list and keep the
  // loop alive, which would leave the operator staring at a finished run. Exit
  // explicitly once everything above has run; the exit code is already set.
  setTimeout(() => process.exit(process.exitCode ?? 0), FORCED_EXIT_MS).unref();
}
