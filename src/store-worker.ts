import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import { MIGRATIONS } from "./migrations.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FAULTS = new Set(["startup", "call", "hang-close", "journal"]);

type Fault = "startup" | "call" | "hang-close" | "journal";

if (isMainThread || !parentPort) {
  throw new Error("oc-family-pack: the store worker only runs on a worker thread");
}

const port = parentPort;
const data = workerData as { stateDir?: unknown; fault?: unknown };
if (!data || typeof data.stateDir !== "string" || data.stateDir.length === 0) {
  throw new Error("oc-family-pack: store worker requires a state directory");
}
if (data.fault !== undefined && (typeof data.fault !== "string" || !FAULTS.has(data.fault))) {
  throw new Error("oc-family-pack: unknown store fault");
}
const fault = data.fault as Fault | undefined;
const stateDir = data.stateDir;

if (fault === "startup") {
  throw new Error("oc-family-pack: injected store worker fault during startup");
}

const dbPath = join(stateDir, "plugins", "oc-family-pack", "oc-family-pack.sqlite");
const directory = join(stateDir, "plugins", "oc-family-pack");
mkdirSync(directory, { recursive: true, mode: DIR_MODE });
chmodSync(directory, DIR_MODE);
if (!existsSync(dbPath)) closeSync(openSync(dbPath, "a", FILE_MODE));
chmodSync(dbPath, FILE_MODE);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
let journalMode = readJournalMode(db.prepare("PRAGMA journal_mode = WAL").get());
if (fault === "journal") journalMode = "delete";
if (journalMode !== "wal") {
  throw new Error(`oc-family-pack: SQLite journal_mode is ${journalMode || "unknown"}, expected wal`);
}
// WAL creates -wal and -shm after the database file is chmod'd. Tighten them too;
// SQLite otherwise follows the process umask.
for (const suffix of ["-wal", "-shm"]) {
  const sidecar = dbPath + suffix;
  if (existsSync(sidecar)) chmodSync(sidecar, FILE_MODE);
}
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

const migration = applyMigrations(db);

const versionRow = db.prepare("SELECT sqlite_version() AS version").get() as { version?: string } | undefined;
const sqliteVersion = typeof versionRow?.version === "string" ? versionRow.version : "";

port.postMessage({
  type: "ready",
  appliedNow: migration.appliedNow,
  applied: migration.applied,
  unknown: migration.unknown,
  sqliteVersion,
  journalMode,
  isMainThread: false,
  nodeVersion: process.version,
});

let calls = 0;

const handlers: Record<string, (input: unknown) => unknown> = {
  "store.status": () => {
    const applied = listApplied();
    const known = new Set(MIGRATIONS.map((entry) => entry.id));
    return {
      isMainThread: false,
      threadId,
      scriptUrl: import.meta.url,
      nodeVersion: process.version,
      sqliteVersion,
      journalMode: readJournalMode(db.prepare("PRAGMA journal_mode").get()),
      applied,
      unknown: applied.filter((id) => !known.has(id)),
    };
  },
  "writeLog.countCommitted": (input) => {
    const baseKey = field(input, "baseKey");
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM oc_family_pack_write_log WHERE base_key = ? AND status = 'committed'")
      .get(baseKey) as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  },
  "writeLog.committed": (input) => {
    const row = db
      .prepare("SELECT event_id AS eventId, before_json AS beforeJson, after_json AS afterJson FROM oc_family_pack_write_log WHERE request_key = ? AND status = 'committed'")
      .get(field(input, "requestKey")) as { eventId: string | null; beforeJson: string | null; afterJson: string | null } | undefined;
    return row ? { eventId: row.eventId, beforeJson: row.beforeJson, afterJson: row.afterJson } : null;
  },
  // A path that wrote uses a plain INSERT, so a second committed row for one key fails
  // loudly. Only the live-match path, which found the event already in Google, ignores
  // a row that is already there.
  "writeLog.append": (input) => {
    const ifAbsent = isRecord(input) && input.ifAbsent === true;
    const row = isRecord(input) ? input.row : undefined;
    const verb = ifAbsent ? "INSERT OR IGNORE" : "INSERT";
    const result = db
      .prepare(
        `${verb} INTO oc_family_pack_write_log (request_key, base_key, requester, op, calendar_id, event_id, before_json, after_json, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        field(row, "requestKey"),
        field(row, "baseKey"),
        field(row, "requester"),
        field(row, "op"),
        field(row, "calendarId"),
        optional(row, "eventId"),
        optional(row, "beforeJson"),
        optional(row, "afterJson"),
        field(row, "status"),
        Date.now(),
      );
    return { inserted: Number(result.changes) === 1 };
  },
  "deliveryLog.append": (input) => {
    const row = isRecord(input) ? input.row : undefined;
    const result = db
      .prepare(
        "INSERT INTO oc_family_pack_delivery_log (delivery_key, kind, target, status, error_kind, error_detail, receipt_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        field(row, "deliveryKey"),
        field(row, "kind"),
        field(row, "target"),
        field(row, "status"),
        optional(row, "errorKind"),
        optional(row, "errorDetail"),
        optional(row, "receiptJson"),
        Date.now(),
      );
    return { id: Number(result.lastInsertRowid) };
  },
  // failed is the one status that is tried again: nothing reached the host.
  "deliveryLog.done": (input) =>
    db
      .prepare("SELECT 1 AS found FROM oc_family_pack_delivery_log WHERE delivery_key = ? AND status IN ('sent', 'partial', 'held', 'unknown') LIMIT 1")
      .get(field(input, "deliveryKey")) !== undefined,
  "deliveryLog.streakStart": (input) => {
    const row = db
      .prepare(
        `SELECT id, status FROM oc_family_pack_delivery_log WHERE kind = ? AND target = ? AND status <> 'sent'
         AND id > COALESCE((SELECT MAX(id) FROM oc_family_pack_delivery_log WHERE kind = ? AND target = ? AND status = 'sent'), 0)
         ORDER BY id LIMIT 1`,
      )
      .get(field(input, "kind"), field(input, "target"), field(input, "kind"), field(input, "target")) as { id: number; status: string } | undefined;
    return row ? { id: Number(row.id), status: row.status } : null;
  },
  "reminderMode.append": (input) => {
    const mode = field(input, "mode");
    if (mode !== "dm" && mode !== "channel" && mode !== "off") throw new Error("oc-family-pack: reminder mode is dm, channel or off");
    const result = db.prepare("INSERT INTO oc_family_pack_reminder_mode (profile_id, mode, at) VALUES (?, ?, ?)").run(field(input, "profileId"), mode, Date.now());
    return { id: Number(result.lastInsertRowid) };
  },
  "reminderMode.latest": () => {
    const rows = db.prepare("SELECT profile_id AS profileId, mode FROM oc_family_pack_reminder_mode WHERE id IN (SELECT MAX(id) FROM oc_family_pack_reminder_mode GROUP BY profile_id)").all() as { profileId: string; mode: string }[];
    const modes: Record<string, string> = {};
    for (const row of rows) modes[row.profileId] = row.mode;
    return modes;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(input: unknown, name: string): string {
  const value = isRecord(input) ? input[name] : undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`oc-family-pack: store call needs ${name}`);
  return value;
}

function optional(input: unknown, name: string): string | null {
  const value = isRecord(input) ? input[name] : undefined;
  return typeof value === "string" ? value : null;
}

port.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const record = message as { type?: unknown; id?: unknown; op?: unknown; input?: unknown };
  if (record.type === "close") {
    if (fault === "hang-close") return;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    port.postMessage({ type: "closed" });
    process.exit(0);
  }
  if (typeof record.id !== "number" || typeof record.op !== "string") return;
  if (fault === "call") {
    db.prepare("SELECT sqlite_version() AS version").get();
    calls += 1;
    if (calls >= 2) throw new Error("oc-family-pack: injected store worker fault during store.status");
    return;
  }
  const handler = handlers[record.op];
  if (!handler) {
    port.postMessage({ type: "result", id: record.id, ok: false, error: `unknown store op ${record.op}` });
    return;
  }
  try {
    port.postMessage({ type: "result", id: record.id, ok: true, result: handler(record.input) });
  } catch (error) {
    port.postMessage({
      type: "result",
      id: record.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function readJournalMode(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const record = row as Record<string, unknown>;
  const value = record.journal_mode ?? Object.values(record)[0];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function tableReady(): boolean {
  const row = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'oc_family_pack_schema_migrations'",
  ).get() as { found?: number } | undefined;
  return row?.found === 1;
}

function listApplied(): string[] {
  if (!tableReady()) return [];
  const rows = db.prepare("SELECT id FROM oc_family_pack_schema_migrations ORDER BY id").all() as { id?: string }[];
  return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
}

function applyMigrations(database: DatabaseSync): { appliedNow: string[]; applied: string[]; unknown: string[] } {
  const known = new Set(MIGRATIONS.map((entry) => entry.id));
  const appliedNow: string[] = [];
  for (const entry of MIGRATIONS) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (listApplied().includes(entry.id)) {
        database.exec("COMMIT");
        continue;
      }
      database.exec(entry.sql);
      database.prepare("INSERT INTO oc_family_pack_schema_migrations (id, applied_at) VALUES (?, ?)").run(entry.id, Date.now());
      database.exec("COMMIT");
      appliedNow.push(entry.id);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction is already closed when SQLite aborted it.
      }
      throw error;
    }
  }
  const applied = listApplied();
  return { appliedNow, applied, unknown: applied.filter((id) => !known.has(id)) };
}
