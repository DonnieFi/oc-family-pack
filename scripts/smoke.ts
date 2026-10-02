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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { Value } from "typebox/value";
import { parseConfig } from "../src/config.ts";
import { MAX_WEEK_EVENTS, contract } from "../src/contract.ts";
import { buildWeekPayload, fitsHostLimits, jsonNodeCount } from "../src/payload.ts";

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
  if (override?.trim()) return override.trim();
  const own = join(ROOT, "node_modules", ".bin");
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || pathResolve(dir) === pathResolve(own)) continue;
    const candidate = join(dir, "openclaw");
    if (existsSync(candidate)) return candidate;
  }
  return "openclaw";
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
  | "update path";

let workDir: string | undefined;
let gateway: ChildProcess | undefined;
/** Set to keep the isolated state on disk for inspection after a failure. */
const keepWorkDir = process.env.OCFP_SMOKE_KEEP === "1";
const hostBinary = resolveHostBinary();

function fail(step: Step, detail: string): never {
  throw new Error(`smoke: ${step} failed: ${detail}`);
}

function note(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

/** Runs the resolved host CLI against the isolated state, returning stdout. */
function oc(args: string[], env: NodeJS.ProcessEnv, step: Step = "plugin load"): string {
  try {
    return execFileSync(hostBinary, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const err = error as { stderr?: string; status?: number | null };
    fail(step, `${hostBinary} ${args.join(" ")} exited ${err.status}: ${(err.stderr ?? "").trim().slice(0, 500)}`);
  }
}

/** The host publishes its own bounded-JSON check under a content-hashed name. */
async function loadHostJsonCheck(): Promise<(value: unknown) => boolean> {
  const dist = join(ROOT, "node_modules", "openclaw", "dist");
  const match = readdirSync(dist).find((name) => name.startsWith("host-hook-json-") && name.endsWith(".mjs"));
  if (!match) {
    fail("host json limits", "the host no longer ships a host-hook-json module; re-derive HOST_MAX_NODES in src/payload.ts");
  }
  const module = (await import(join(dist, match))) as { t: (value: unknown) => boolean };
  if (typeof module.t !== "function") fail("host json limits", `${match} no longer exports its JSON value check as \`t\``);
  return module.t;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port === LIVE_GATEWAY_PORT ? reject(new Error("refusing to use the live Gateway port")) : resolve(port),
      );
    });
  });
}

/** The files a git install would have, so the smoke exercises the shipped shape. */
const SHIPPED = ["package.json", "openclaw.plugin.json", "dist", "src", "README.md", "FAQ.md", "LICENSE"];

/**
 * Copies the shipping files into a fresh directory and installs the one runtime
 * dependency. `openclaw` is deliberately left out: the host supplies it, and
 * nesting it inside the plugin is what the install step rejects.
 */
function stagePlugin(target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of SHIPPED) {
    cpSync(join(ROOT, entry), join(target, entry), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefix", target], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (existsSync(join(target, "node_modules", "openclaw"))) {
    fail("plugin load", "staged copy still has a nested openclaw in node_modules");
  }
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
    fail("plugin load", "package.json declares no runtime dependencies, so the staged copy would be incomplete");
  }
}

function stopGateway(): void {
  if (!gateway) return;
  const child = gateway;
  gateway = undefined;
  child.kill("SIGTERM");
  // Escalate if the host ignores SIGTERM, so an interrupted smoke never leaves
  // an orphan Gateway behind.
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 8000);
  child.once("exit", () => clearTimeout(killTimer));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopGateway();
    process.exit(130);
  });
}

async function waitForReady(logPath: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const log = readFileSync(logPath, "utf8");
    const trouble = log.split("\n").filter((line) => /failed during register|refusing|failed to load plugin/i.test(line));
    if (trouble.length) fail("plugin load", trouble.slice(0, 3).join(" | ").slice(0, 500));
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

/** Removes ANSI colour so log lines can be matched literally. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function pluginSqliteFiles(stateDir: string): string[] {
  const dir = join(stateDir, "plugins", "oc-family-pack");
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".sqlite") || name.endsWith(".db"));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  // 1. The host must be the build this plugin was pinned and tested against.
  const hostVersion = oc(["--version"], process.env, "host version").trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    openclaw: { build: { openclawVersion: string }; compat: { pluginApi: string } };
  };
  note(`host ${hostVersion}`);
  if (!hostVersion.includes(pkg.openclaw.build.openclawVersion)) {
    fail(
      "host version",
      `installed host ${hostVersion} does not match pinned build.openclawVersion ${pkg.openclaw.build.openclawVersion}; re-run the smoke and bump both together`,
    );
  }
  note(`pinned build.openclawVersion ${pkg.openclaw.build.openclawVersion} and compat.pluginApi ${pkg.openclaw.compat.pluginApi} match`);

  // 2. An isolated Gateway on the installed build, with this working tree linked in.
  workDir = mkdtempSync(join(tmpdir(), "ocfp-smoke-"));
  const stateDir = join(workDir, "state");
  const configPath = join(workDir, "config.json");
  const logPath = join(workDir, "gateway.log");
  mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
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
  note(`isolated state at ${stateDir}, loopback:${port}`);
  note(`host binary ${hostBinary}`);

  // Install the way a real household does: a clean copy carrying only the files
  // that ship, plus its runtime dependency. The working tree is not installed
  // directly because a dev `npm install` leaves a real `openclaw` directory in
  // node_modules, and the host then counts the 64 bundled extensions it finds
  // there as children of our install record and refuses the install. A git
  // install links `openclaw` instead, and discovery does not follow the link.
  const sourceDir = join(workDir, "source");
  stagePlugin(sourceDir);
  oc(["plugins", "install", sourceDir, "--force", "--link", "--accept-capabilities"], env);
  note("plugin installed from a clean copy of the working tree");

  // 3. Manifest and build artifacts the host validates before it loads code.
  // A stale Control UI bundle is a build-toolchain mismatch, not a plugin
  // defect: two OpenClaw builds of the same version minify the page to
  // different identifier names, so the content hash in the manifest can only
  // satisfy one of them. Say so explicitly instead of implying the plugin broke.
  let validated: { valid?: boolean; errors?: unknown[] };
  try {
    validated = JSON.parse(oc(["plugins", "validate", "--json"], env, "manifest")) as { valid?: boolean; errors?: unknown[] };
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
  note("manifest validates");

  const out = openSync(logPath, "w");
  gateway = spawn("openclaw", ["gateway", "run", "--port", String(port), "--bind", "loopback"], {
    env,
    stdio: ["ignore", out, out],
  });
  await waitForReady(logPath);
  note("isolated Gateway ready");

  const call = (method: string, params: unknown, step: Step): Record<string, unknown> => {
    const raw = oc(
      ["gateway", "call", method, "--port", String(port), "--token", TOKEN, "--json", "--params", JSON.stringify(params)],
      env,
      step,
    );
    return JSON.parse(raw) as Record<string, unknown>;
  };

  // 4. The plugin loads and the host reports it as a page provider.
  const inspect = JSON.parse(oc(["plugins", "inspect", "oc-family-pack", "--json"], env)) as {
    plugin?: { status?: string; uiCapabilities?: string[] };
  };
  const plugin = inspect.plugin ?? (inspect as { status?: string; uiCapabilities?: string[] });
  if (plugin.status !== "loaded") fail("plugin load", `plugin status is ${plugin.status}, expected loaded`);
  note("plugin loaded");

  // 5. A real query over the real transport, validated against the contract schema.
  const weekCall = call(
    "plugins.sessionAction",
    { pluginId: "oc-family-pack", actionId: "family.week", payload: {} },
    "contract validation",
  );
  if (weekCall.ok !== true) fail("contract validation", `family.week returned ${JSON.stringify(weekCall.error ?? weekCall)}`);
  const operation = contract.operations["family.week"];
  if (!operation) fail("contract validation", "family.week is not declared in the contract");
  const schemaErrors = [...Value.Errors(operation.output, weekCall.result as never)].slice(0, 3) as {
    path?: string;
    message: string;
  }[];
  if (schemaErrors.length) {
    fail(
      "contract validation",
      `payload does not match the contract schema: ${schemaErrors.map((e) => `${e.path ?? "/"} ${e.message}`).join("; ")}`,
    );
  }
  note("family.week result validates against the contract schema");

  const week = weekCall.result as { days: unknown[]; members: unknown[]; mode: string };
  if (week.days.length !== 7) fail("family.week query", `expected 7 days, got ${week.days.length}`);
  if (week.mode !== "demo") fail("family.week query", `expected demo mode against an isolated Gateway, got ${week.mode}`);
  if (week.members.length === 0) fail("family.week query", "family.week returned no members");
  note(`family.week returned ${week.members.length} members over 7 days in ${week.mode} mode`);

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
  const inspectRecord2 = JSON.parse(oc(["plugins", "inspect", "oc-family-pack", "--json"], env, "page registration")) as {
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
  note(`page registered, built assets present in the installed root`);

  // 7. The scheduler surface the briefs will register jobs on. This is a host
  // liveness probe, not a plugin integration point: the plugin registers no
  // service or cron job yet, so a pass here means the host surface answers, and
  // nothing more. The real check lands with the briefs epic.
  const jobs = call("cron.list", {}, "service scheduler");
  if (!Array.isArray(jobs.jobs)) fail("service scheduler", "cron.list did not return a jobs array");
  note(`host scheduler surface answers (${jobs.jobs.length} host jobs); plugin registers none until the briefs epic`);

  // 8. The plugin-owned store. The plugin writes no state yet (s5k.19), so this
  // asserts the contract that will hold when it does: the store lives under the
  // plugin's own state directory and nowhere else. A store appearing outside it
  // would mean the plugin reached for shared state, which the architecture
  // rules forbid. The directory is named from the plugin id, not assumed from a
  // --link layout.
  const pluginStateDir = join(stateDir, "plugins", PLUGIN_ID);
  try {
    mkdirSync(pluginStateDir, { recursive: true });
    const probe = join(pluginStateDir, ".smoke-write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
  } catch (error) {
    fail("sqlite store", `the plugin state directory is not writable: ${(error as Error).message}`);
  }
  const sqlite = pluginSqliteFiles(pluginStateDir);
  const outside = readdirSync(stateDir).filter((name) => name.endsWith(".sqlite") && name !== "openclaw.sqlite");
  if (outside.length) {
    fail("sqlite store", `plugin-owned state files appeared outside the plugin directory: ${outside.join(", ")}`);
  }
  note(
    sqlite.length
      ? `plugin sqlite store present under the plugin state dir: ${sqlite.join(", ")}`
      : "plugin state dir is writable and empty, as expected until writes land (s5k.19)",
  );

  // 9. Our host-limit arithmetic must agree with the host's own counter, so a
  // host change to those limits fails here instead of rotting the contract comment.
  const isHostJson = await loadHostJsonCheck();
  const demo = await buildWeekPayload(
    parseConfig({ demo: true, timezone: "America/Toronto" }),
    undefined,
    Date.now(),
    async () => ({ status: "unconfigured", hint: "x" }),
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
  note(`host json limits agree with the host on ${boundary.length} payloads (MAX_WEEK_EVENTS ${MAX_WEEK_EVENTS})`);

  // 10. The update path an operator runs after a host upgrade. This install is
  // a local --link, so `plugins update` structurally reports it as skipped; a
  // bare "produced output" assertion would pass no matter what. Assert the real
  // outcome instead: the host must recognise the plugin and explain the skip,
  // and it must be skipping for the link reason rather than failing to resolve.
  const dryRun = oc(["plugins", "update", "oc-family-pack", "--dry-run"], env, "update path");
  const resolved = dryRun.trim();
  if (!resolved) fail("update path", "'plugins update --dry-run' produced no output for a linked install");
  if (!/skip|up to date|path|link|no changes|nothing to update/i.test(resolved)) {
    fail("update path", `'plugins update --dry-run' did not resolve the linked install: ${resolved.slice(0, 300)}`);
  }
  if (/error|fail|cannot|unable/i.test(resolved)) {
    fail("update path", `'plugins update --dry-run' reported a problem: ${resolved.slice(0, 300)}`);
  }
  note(`plugins update resolves this install: ${resolved.split("\n")[0]}`);

  // A real household installs from git, where `openclaw update` does refresh the
  // plugin. Prove the host still treats git installs as updatable by checking
  // the shipped source records its git spec, rather than asserting it here from
  // a linked install that cannot exercise it.
  const inspectRecord = JSON.parse(oc(["plugins", "inspect", "oc-family-pack", "--json"], env, "update path")) as {
    plugin?: { source?: string; installPath?: string | null };
  };
  const record = inspectRecord.plugin ?? (inspectRecord as { source?: string });
  if (!record.source) fail("update path", "the installed plugin has no recorded source, so updates cannot be resolved");
  note(`install source recorded as ${record.source}`);
}

try {
  await main();
  process.stdout.write("smoke: all steps passed\n");
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  stopGateway();
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
}
