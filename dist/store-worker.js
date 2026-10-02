import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import { MIGRATIONS } from "./migrations.js";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FAULTS = new Set(["startup", "call", "hang-close", "journal"]);
if (isMainThread || !parentPort) {
    throw new Error("oc-family-pack: the store worker only runs on a worker thread");
}
const port = parentPort;
const data = workerData;
if (!data || typeof data.stateDir !== "string" || data.stateDir.length === 0) {
    throw new Error("oc-family-pack: store worker requires a state directory");
}
if (data.fault !== undefined && (typeof data.fault !== "string" || !FAULTS.has(data.fault))) {
    throw new Error("oc-family-pack: unknown store fault");
}
const fault = data.fault;
const stateDir = data.stateDir;
if (fault === "startup") {
    throw new Error("oc-family-pack: injected store worker fault during startup");
}
const dbPath = join(stateDir, "plugins", "oc-family-pack", "oc-family-pack.sqlite");
const directory = join(stateDir, "plugins", "oc-family-pack");
mkdirSync(directory, { recursive: true, mode: DIR_MODE });
chmodSync(directory, DIR_MODE);
if (!existsSync(dbPath))
    closeSync(openSync(dbPath, "a", FILE_MODE));
chmodSync(dbPath, FILE_MODE);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
let journalMode = readJournalMode(db.prepare("PRAGMA journal_mode = WAL").get());
if (fault === "journal")
    journalMode = "delete";
if (journalMode !== "wal") {
    throw new Error(`oc-family-pack: SQLite journal_mode is ${journalMode || "unknown"}, expected wal`);
}
// WAL creates -wal and -shm after the database file is chmod'd. Tighten them too;
// SQLite otherwise follows the process umask.
for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar))
        chmodSync(sidecar, FILE_MODE);
}
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
const migration = applyMigrations(db);
const versionRow = db.prepare("SELECT sqlite_version() AS version").get();
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
const handlers = {
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
};
port.on("message", (message) => {
    if (!message || typeof message !== "object")
        return;
    const record = message;
    if (record.type === "close") {
        if (fault === "hang-close")
            return;
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        port.postMessage({ type: "closed" });
        process.exit(0);
    }
    if (typeof record.id !== "number" || typeof record.op !== "string")
        return;
    if (fault === "call") {
        db.prepare("SELECT sqlite_version() AS version").get();
        calls += 1;
        if (calls >= 2)
            throw new Error("oc-family-pack: injected store worker fault during store.status");
        return;
    }
    const handler = handlers[record.op];
    if (!handler) {
        port.postMessage({ type: "result", id: record.id, ok: false, error: `unknown store op ${record.op}` });
        return;
    }
    try {
        port.postMessage({ type: "result", id: record.id, ok: true, result: handler() });
    }
    catch (error) {
        port.postMessage({
            type: "result",
            id: record.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
function readJournalMode(row) {
    if (!row || typeof row !== "object")
        return "";
    const record = row;
    const value = record.journal_mode ?? Object.values(record)[0];
    return typeof value === "string" ? value.toLowerCase() : "";
}
function tableReady() {
    const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'oc_family_pack_schema_migrations'").get();
    return row?.found === 1;
}
function listApplied() {
    if (!tableReady())
        return [];
    const rows = db.prepare("SELECT id FROM oc_family_pack_schema_migrations ORDER BY id").all();
    return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
}
function applyMigrations(database) {
    const known = new Set(MIGRATIONS.map((entry) => entry.id));
    const appliedNow = [];
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
        }
        catch (error) {
            try {
                database.exec("ROLLBACK");
            }
            catch {
                // The transaction is already closed when SQLite aborted it.
            }
            throw error;
        }
    }
    const applied = listApplied();
    return { appliedNow, applied, unknown: applied.filter((id) => !known.has(id)) };
}
