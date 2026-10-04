import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { FamilyStore, StoreFault } from "./store.ts";
import { STORE_CLOSE_TIMEOUT_MS } from "./store.ts";

const DIST_STORE = new URL("../dist/store.js", import.meta.url);

type StoreModule = {
  openFamilyStore: (options: {
    stateDir: string;
    fault?: StoreFault;
    reportFailure?: (error: unknown) => void;
    logger?: { warn: (message: string) => void };
    schedule?: (fn: () => void, ms: number) => { cancel: () => void };
    onWorker?: (worker: { on: (event: "exit", listener: (code: number) => void) => void; terminate: () => Promise<number> }) => void;
  }) => Promise<FamilyStore>;
};

async function loadStore(): Promise<StoreModule> {
  return (await import(DIST_STORE.href)) as StoreModule;
}

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "ocfp-store-"));
}

function dbPath(stateDir: string): string {
  return join(stateDir, "plugins", "oc-family-pack", "oc-family-pack.sqlite");
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function sqliteJson(path: string, sql: string, mutate = false): unknown {
  const script = mutate
    ? `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.env.DB);
       db.exec(process.env.SQL);
       db.close();`
    : `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.env.DB);
       const rows = db.prepare(process.env.SQL).all();
       db.close();
       process.stdout.write(JSON.stringify(rows));`;
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    env: { ...process.env, DB: path, SQL: sql },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite probe exited ${result.status}`);
  }
  return mutate ? undefined : (JSON.parse(result.stdout) as unknown);
}

function migrationRows(path: string): { id: string; applied_at: number }[] {
  return sqliteJson(path, "SELECT id, applied_at FROM oc_family_pack_schema_migrations ORDER BY id") as {
    id: string;
    applied_at: number;
  }[];
}

function assertPermissions(path: string): void {
  assert.equal(mode(join(path, "..")), 0o700);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path + suffix;
    assert.equal(existsSync(file), true, file);
    assert.equal(mode(file), 0o600, file);
  }
}

test("the built store module is the one production loads", () => {
  assert.equal(existsSync(DIST_STORE), true);
  const source = readFileSync(DIST_STORE, "utf8");
  assert.match(source, /new URL\("\.\/store-worker\.js", import\.meta\.url\)/);
  const worker = new URL("./store-worker.js", DIST_STORE);
  assert.equal(existsSync(worker), true);
  assert.match(readFileSync(worker, "utf8"), /node:sqlite/);
  const mainFiles = ["index.js", "store.js", "migrations.js", "handlers.js"].map((name) => readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8"));
  for (const sourceFile of mainFiles) assert.equal(sourceFile.includes("node:sqlite"), false);
});

test("a first start applies 0001 to 0004 and a second start applies nothing", async () => {
  const stateDir = tempState();
  const previous = process.umask(0o022);
  const { openFamilyStore } = await loadStore();
  try {
    const first = await openFamilyStore({ stateDir });
    assert.deepEqual(first.ready.appliedNow, ["0001-initial", "0002-write-log", "0003-delivery-log", "0004-reminder-mode"]);
    assert.deepEqual(first.ready.applied, ["0001-initial", "0002-write-log", "0003-delivery-log", "0004-reminder-mode"]);
    assert.deepEqual(first.ready.unknown, []);
    assert.equal(first.ready.journalMode, "wal");
    assert.equal(first.ready.isMainThread, false);
    const status = await first.status();
    assert.equal(status.isMainThread, false);
    assert.equal(status.journalMode, "wal");
    assert.equal(status.scriptUrl.endsWith("/dist/store-worker.js"), true);
    assertPermissions(dbPath(stateDir));
    const rows = migrationRows(dbPath(stateDir));
    assert.deepEqual(rows.map((row) => row.id), ["0001-initial", "0002-write-log", "0003-delivery-log", "0004-reminder-mode"]);
    const appliedAt = rows[0]?.applied_at;
    await first.stop();

    const second = await openFamilyStore({ stateDir });
    assert.deepEqual(second.ready.appliedNow, []);
    assert.deepEqual(second.ready.applied, ["0001-initial", "0002-write-log", "0003-delivery-log", "0004-reminder-mode"]);
    assert.equal(second.ready.journalMode, "wal");
    assertPermissions(dbPath(stateDir));
    const again = migrationRows(dbPath(stateDir));
    assert.equal(again[0]?.applied_at, appliedAt);
    await second.stop();
  } finally {
    process.umask(previous);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the delivery log is strict and append-only, and a key is sent at most once", async () => {
  const stateDir = tempState();
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({ stateDir });
  try {
    const base = { kind: "daily", target: "family" } as const;
    const failed = await store.appendDeliveryLog({ ...base, deliveryKey: "daily-summary:2026-11-01", status: "failed", errorKind: "no-channel", errorDetail: "no Discord id" });
    assert.equal(await store.deliveryDone("daily-summary:2026-11-01"), false, "failed is tried again");
    for (const status of ["held", "unknown", "partial"] as const) {
      const key = `daily-summary:${status}`;
      await store.appendDeliveryLog({ ...base, deliveryKey: key, status, errorKind: "other", errorDetail: "x" });
      assert.equal(await store.deliveryDone(key), true, status);
    }
    await store.appendDeliveryLog({ ...base, deliveryKey: "daily-summary:2026-11-01", status: "sent", receiptJson: "{}" });
    assert.equal(await store.deliveryDone("daily-summary:2026-11-01"), true);
    await assert.rejects(store.appendDeliveryLog({ ...base, deliveryKey: "daily-summary:2026-11-01", status: "sent" }), /UNIQUE/);
    await assert.rejects(store.appendDeliveryLog({ ...base, deliveryKey: "k", status: "sent", errorKind: "other" }), /CHECK/, "a sent row has no error_kind");
    await assert.rejects(store.appendDeliveryLog({ ...base, deliveryKey: "k", status: "unknown" }), /CHECK/, "every other row has one");
    await assert.rejects(store.appendDeliveryLog({ ...base, deliveryKey: "k", status: "unknown", errorKind: "other", errorDetail: "d".repeat(201) }), /CHECK/);
    await assert.rejects(store.appendDeliveryLog({ ...base, deliveryKey: "k", status: "lost" as "sent" }), /CHECK/);
    await assert.rejects(store.appendDeliveryLog({ ...base, kind: "digest" as "daily", deliveryKey: "k", status: "sent" }), /CHECK/);
    const path = dbPath(stateDir);
    assert.throws(() => sqliteJson(path, `UPDATE oc_family_pack_delivery_log SET status = 'sent' WHERE id = ${failed.id}`, true), /append-only/);
    assert.throws(() => sqliteJson(path, "DELETE FROM oc_family_pack_delivery_log", true), /append-only/);
    assert.throws(() => sqliteJson(path, "INSERT INTO oc_family_pack_delivery_log (delivery_key, kind, target, status, error_kind, at) VALUES ('k', 'daily', 't', 'held', 'other', 'soon')", true), /cannot store TEXT/);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reminder mode keeps the latest row per person and refuses updates", async () => {
  const stateDir = tempState();
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({ stateDir });
  try {
    await store.appendReminderMode("riley", "off");
    const latest = await store.appendReminderMode("riley", "channel");
    await store.appendReminderMode("alex", "dm");
    assert.deepEqual(await store.reminderModes(), { riley: "channel", alex: "dm" });
    const path = dbPath(stateDir);
    assert.throws(() => sqliteJson(path, `UPDATE oc_family_pack_reminder_mode SET mode = 'off' WHERE id = ${latest.id}`, true), /append-only/);
    assert.throws(() => sqliteJson(path, "DELETE FROM oc_family_pack_reminder_mode", true), /append-only/);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a streak starts at the first row that was not sent since the last sent one for its kind and target", async () => {
  const stateDir = tempState();
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({ stateDir });
  try {
    const row = (deliveryKey: string, status: "sent" | "held" | "unknown", target = "family") =>
      store.appendDeliveryLog({ deliveryKey, kind: "daily", target, status, ...(status === "sent" ? {} : { errorKind: "other" as const }) });
    assert.equal(await store.deliveryStreakStart("daily", "family"), undefined);
    await row("a", "held");
    await row("b", "sent");
    assert.equal(await store.deliveryStreakStart("daily", "family"), undefined);
    const first = await row("c", "unknown");
    await row("d", "held");
    await row("e", "held", "other-channel");
    assert.deepEqual(await store.deliveryStreakStart("daily", "family"), { id: first.id, status: "unknown" });
    assert.equal(await store.deliveryStreakStart("weekly", "family"), undefined);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a directory that already exists as 0755 is tightened to 0700", async () => {
  const stateDir = tempState();
  const directory = join(stateDir, "plugins", "oc-family-pack");
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o755);
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({ stateDir });
  try {
    assert.equal(mode(directory), 0o700);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a database file that already exists as 0644 is tightened with its sidecars", async () => {
  const stateDir = tempState();
  const path = dbPath(stateDir);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, "");
  chmodSync(path, 0o644);
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({ stateDir });
  try {
    assertPermissions(path);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unknown migration id is reported and status still answers", async () => {
  const stateDir = tempState();
  const warnings: string[] = [];
  const { openFamilyStore } = await loadStore();
  const first = await openFamilyStore({ stateDir });
  await first.stop();
  sqliteJson(
    dbPath(stateDir),
    "INSERT INTO oc_family_pack_schema_migrations (id, applied_at) VALUES ('9999-from-a-newer-build', 1)",
    true,
  );
  try {
    const second = await openFamilyStore({
      stateDir,
      logger: { warn: (message) => warnings.push(message) },
    });
    assert.deepEqual(second.ready.unknown, ["9999-from-a-newer-build"]);
    assert.deepEqual(second.ready.appliedNow, []);
    const status = await second.status();
    assert.deepEqual(status.unknown, ["9999-from-a-newer-build"]);
    assert.equal(status.journalMode, "wal");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /9999-from-a-newer-build/);
    await second.stop();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a worker crash rejects both pending calls, reports once, and reopens one worker", async () => {
  const stateDir = tempState();
  const failures: unknown[] = [];
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({
    stateDir,
    fault: "call",
    reportFailure: (error) => failures.push(error),
  });
  try {
    assert.equal(store.spawned(), 1);
    const pending = [store.status(), store.status()];
    const settled = await Promise.allSettled(pending);
    assert.equal(settled[0]?.status, "rejected");
    assert.equal(settled[1]?.status, "rejected");
    assert.equal(failures.length, 1);
    assert.match(String((settled[0] as PromiseRejectedResult).reason), /injected store worker fault during store.status/);
    const [left, right] = await Promise.all([store.status(), store.status()]);
    assert.equal(store.spawned(), 2);
    assert.equal(left.threadId, right.threadId);
    assert.equal(left.isMainThread, false);
    assert.equal(left.journalMode, "wal");
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a startup fault fails the open and leaves the process running", async () => {
  const stateDir = tempState();
  const failures: unknown[] = [];
  const { openFamilyStore } = await loadStore();
  let exited: Promise<unknown> | undefined;
  try {
    await assert.rejects(
      openFamilyStore({
        stateDir,
        fault: "startup",
        reportFailure: (error) => failures.push(error),
        onWorker: (worker) => {
          exited = new Promise((resolve) => worker.on("exit", resolve));
        },
      }),
      /injected store worker fault during startup/,
    );
    // The store reports the exit one turn after the event. Wait past it so a
    // second report would land before the count is checked.
    await exited;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 1);
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a journal_mode other than wal fails the open and reports once", async () => {
  const stateDir = tempState();
  const failures: unknown[] = [];
  const { openFamilyStore } = await loadStore();
  try {
    await assert.rejects(
      openFamilyStore({
        stateDir,
        fault: "journal",
        reportFailure: (error) => failures.push(error),
      }),
      /journal_mode is delete, expected wal/,
    );
    assert.equal(failures.length, 1);
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("stop closes a healthy worker without the terminate fallback", async () => {
  const stateDir = tempState();
  const exits: number[] = [];
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({
    stateDir,
    onWorker: (worker) => worker.on("exit", (code) => exits.push(code)),
  });
  await store.stop();
  assert.deepEqual(exits, [0]);
  assert.equal(migrationRows(dbPath(stateDir))[0]?.id, "0001-initial");
  rmSync(stateDir, { recursive: true, force: true });
});

test("stop terminates a worker that hangs on close after the 5 second timeout", async () => {
  assert.equal(STORE_CLOSE_TIMEOUT_MS, 5000);
  const stateDir = tempState();
  const exits: number[] = [];
  let scheduledMs = 0;
  let fire: (() => void) | undefined;
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({
    stateDir,
    fault: "hang-close",
    onWorker: (worker) => worker.on("exit", (code) => exits.push(code)),
    schedule: (fn, ms) => {
      scheduledMs = ms;
      fire = fn;
      return { cancel: () => undefined };
    },
  });
  let settled = false;
  const stopped = store.stop().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(scheduledMs, 5000);
  assert.equal(exits.length, 0);
  fire?.();
  await stopped;
  assert.equal(settled, true);
  assert.deepEqual(exits, [1]);
  rmSync(stateDir, { recursive: true, force: true });
});

test("the family-store service opens the database, and discovery does not register it", async () => {
  const loaded = (await import(new URL("../dist/index.js", import.meta.url).href)) as {
    default: { register: (api: unknown) => void };
  };
  const plugin = loaded.default;
  const discovery: { id: string }[] = [];
  plugin.register({
    id: "oc-family-pack",
    registrationMode: "discovery",
    pluginConfig: { demo: true },
    registerService(service: { id: string }) {
      discovery.push(service);
    },
    registerSessionAction() {},
    registerTool() {},
    on() {},
    registerGatewayMethod() {},
    registerCli() {},
  });
  // The SDK registers its own event relay whenever the contract declares events; the family-store and calendar-watch services stay out of discovery.
  assert.deepEqual(discovery.map((service) => service.id), ["oc-family-pack:feature-events"]);

  const services: {
    id: string;
    reload?: { configPrefixes: readonly string[] };
    start: (ctx: unknown) => Promise<void>;
    stop?: (ctx: unknown) => Promise<void>;
  }[] = [];
  plugin.register({
    id: "oc-family-pack",
    registrationMode: "full",
    pluginConfig: { demo: true },
    registerService(service: (typeof services)[number]) {
      services.push(service);
    },
    registerSessionAction() {},
    registerTool() {},
    on() {},
    registerGatewayMethod() {},
    registerCli() {},
  });
  assert.deepEqual(services.map((entry) => entry.id).sort(), ["calendar-watch", "family-reminders", "family-store", "oc-family-pack:feature-events"]);
  const service = services.find((entry) => entry.id === "family-store");
  assert.ok(service);
  assert.deepEqual(service.reload?.configPrefixes, ["plugins.entries.oc-family-pack.config"]);
  const stateDir = tempState();
  const failures: unknown[] = [];
  const logs: string[] = [];
  try {
    await service.start({
      stateDir,
      config: {},
      logger: {
        info: (message: string) => logs.push(message),
        warn: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
      },
      serviceHealth: {
        reportFailure: (error: unknown) => failures.push(error),
        clearFailure() {},
      },
    });
    assert.equal(failures.length, 0);
    assert.equal(migrationRows(dbPath(stateDir))[0]?.id, "0001-initial");
    assert.match(logs.join("\n"), new RegExp(`node ${process.version}`));
    assertPermissions(dbPath(stateDir));
    await service.stop?.({});
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("fake timers fire the 5 second terminate fallback", async () => {
  const stateDir = tempState();
  const exits: number[] = [];
  let worker: { terminate: () => Promise<number> } | undefined;
  const { openFamilyStore } = await loadStore();
  const store = await openFamilyStore({
    stateDir,
    fault: "hang-close",
    onWorker: (spawned) => {
      worker = spawned;
      spawned.on("exit", (code) => exits.push(code));
    },
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const stopped = store.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(exits.length, 0);
    mock.timers.tick(1);
    await stopped;
    assert.equal(settled, true);
    assert.deepEqual(exits, [1]);
  } finally {
    mock.timers.reset();
    await worker?.terminate().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
