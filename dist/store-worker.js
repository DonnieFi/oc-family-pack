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
    "writeLog.countCommitted": (input) => {
        const baseKey = field(input, "baseKey");
        const row = db
            .prepare("SELECT COUNT(*) AS n FROM oc_family_pack_write_log WHERE base_key = ? AND status = 'committed'")
            .get(baseKey);
        return typeof row?.n === "number" ? row.n : 0;
    },
    "writeLog.committed": (input) => {
        const row = db
            .prepare("SELECT event_id AS eventId, before_json AS beforeJson, after_json AS afterJson FROM oc_family_pack_write_log WHERE request_key = ? AND status = 'committed'")
            .get(field(input, "requestKey"));
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
            .prepare(`${verb} INTO oc_family_pack_write_log (request_key, base_key, requester, op, calendar_id, event_id, before_json, after_json, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(field(row, "requestKey"), field(row, "baseKey"), field(row, "requester"), field(row, "op"), field(row, "calendarId"), optional(row, "eventId"), optional(row, "beforeJson"), optional(row, "afterJson"), field(row, "status"), Date.now());
        return { inserted: Number(result.changes) === 1 };
    },
    "deliveryLog.append": (input) => {
        const row = isRecord(input) ? input.row : undefined;
        const result = db
            .prepare("INSERT INTO oc_family_pack_delivery_log (delivery_key, kind, target, target_kind, status, error_kind, error_detail, receipt_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(field(row, "deliveryKey"), field(row, "kind"), field(row, "target"), optional(row, "targetKind"), field(row, "status"), optional(row, "errorKind"), optional(row, "errorDetail"), optional(row, "receiptJson"), Date.now());
        return { id: Number(result.lastInsertRowid) };
    },
    // A failed row means our own pre-send check found no target; there is nothing
    // for the host to retry. A transient host failure is held or unknown instead.
    "deliveryLog.done": (input) => db
        .prepare("SELECT 1 AS found FROM oc_family_pack_delivery_log WHERE delivery_key = ? AND status IN ('sent', 'partial', 'held', 'unknown', 'failed') LIMIT 1")
        .get(field(input, "deliveryKey")) !== undefined,
    "deliveryLog.latest": () => {
        const row = db.prepare("SELECT kind, status, target, target_kind FROM oc_family_pack_delivery_log ORDER BY id DESC LIMIT 1").get();
        const kind = row?.kind;
        const status = row?.status;
        const target = row?.target;
        const targetKind = row?.target_kind === "member" || row?.target_kind === "channel" ? row.target_kind : undefined;
        if ((kind !== "daily" && kind !== "weekly" && kind !== "reminder" && kind !== "household" && kind !== "alert") ||
            (status !== "sent" && status !== "partial" && status !== "failed" && status !== "held" && status !== "unknown") ||
            typeof target !== "string" ||
            target === "") {
            return null;
        }
        return { kind, status, target, ...(targetKind !== undefined ? { targetKind } : {}) };
    },
    "deliveryLog.streakStart": (input) => {
        const row = db
            .prepare(`SELECT id, status FROM oc_family_pack_delivery_log WHERE kind = ? AND target = ? AND status <> 'sent'
         AND id > COALESCE((SELECT MAX(id) FROM oc_family_pack_delivery_log WHERE kind = ? AND target = ? AND status = 'sent'), 0)
         ORDER BY id LIMIT 1`)
            .get(field(input, "kind"), field(input, "target"), field(input, "kind"), field(input, "target"));
        return row ? { id: Number(row.id), status: row.status } : null;
    },
    "reminderMode.append": (input) => {
        const mode = field(input, "mode");
        if (mode !== "dm" && mode !== "channel" && mode !== "off")
            throw new Error("oc-family-pack: reminder mode is dm, channel or off");
        const result = db.prepare("INSERT INTO oc_family_pack_reminder_mode (profile_id, mode, at) VALUES (?, ?, ?)").run(field(input, "profileId"), mode, Date.now());
        return { id: Number(result.lastInsertRowid) };
    },
    "reminderMode.latest": () => {
        const rows = db.prepare("SELECT profile_id AS profileId, mode FROM oc_family_pack_reminder_mode WHERE id IN (SELECT MAX(id) FROM oc_family_pack_reminder_mode GROUP BY profile_id)").all();
        const modes = {};
        for (const row of rows)
            modes[row.profileId] = row.mode;
        return modes;
    },
    "home.seeded": () => {
        const row = db.prepare("SELECT id FROM oc_family_pack_home WHERE id = 'today'").get();
        return row?.id === "today";
    },
    "home.claim": () => {
        const result = db.prepare("INSERT OR IGNORE INTO oc_family_pack_home (id, at) VALUES ('today', ?)").run(Date.now());
        return { inserted: result.changes === 1 };
    },
    "guide.load": () => {
        const row = db.prepare("SELECT body FROM oc_family_pack_guide WHERE id = 'guide'").get();
        return typeof row?.body === "string" ? row.body : null;
    },
    "guide.save": (input) => {
        const body = field(input, "body");
        if (body.length > 8192)
            throw new Error("oc-family-pack: guide checkpoint is too long");
        db.prepare("INSERT INTO oc_family_pack_guide (id, body) VALUES ('guide', ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").run(body);
        return true;
    },
    "identity.book": () => ({
        sources: db.prepare("SELECT calendar_key AS calendarKey, event_id AS eventId, fp_id AS fpId, ical_uid AS iCalUid, series_id AS seriesId, occurrence FROM oc_family_pack_fp_source").all(),
        overrides: db.prepare("SELECT kind, sources_json AS sourcesJson FROM oc_family_pack_fp_override ORDER BY id").all().map((row) => {
            const record = row;
            let sources = [];
            if (typeof record.sourcesJson === "string") {
                try {
                    sources = JSON.parse(record.sourcesJson);
                }
                catch {
                    sources = [];
                }
            }
            return { kind: record.kind, sources };
        }),
        legacy: db.prepare("SELECT fp_id AS fpId, ref FROM oc_family_pack_fp_legacy").all(),
    }),
    "identity.remember": (input) => {
        const sources = arrayField(input, "sources");
        const legacy = arrayField(input, "legacy");
        const dropLegacy = arrayField(input, "dropLegacy");
        db.exec("BEGIN IMMEDIATE");
        try {
            const upsert = db.prepare(`INSERT INTO oc_family_pack_fp_source (calendar_key, event_id, fp_id, ical_uid, series_id, occurrence) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (calendar_key, event_id) DO UPDATE SET fp_id = excluded.fp_id, ical_uid = excluded.ical_uid, series_id = excluded.series_id, occurrence = excluded.occurrence`);
            for (const source of sources) {
                const fpId = field(source, "fpId");
                if (!/^fp_[0-9a-f]{32}$/.test(fpId))
                    throw new Error("oc-family-pack: event identity must be an fp-id");
                upsert.run(field(source, "calendarKey"), field(source, "eventId"), fpId, optional(source, "iCalUid"), optional(source, "seriesId"), optional(source, "occurrence"));
            }
            const addLegacy = db.prepare("INSERT OR IGNORE INTO oc_family_pack_fp_legacy (fp_id, ref) VALUES (?, ?)");
            for (const ref of legacy)
                addLegacy.run(field(ref, "fpId"), field(ref, "ref"));
            const drop = db.prepare("DELETE FROM oc_family_pack_fp_legacy WHERE fp_id = ? AND ref = ?");
            for (const ref of dropLegacy)
                drop.run(field(ref, "fpId"), field(ref, "ref"));
            db.exec("COMMIT");
        }
        catch (error) {
            try {
                db.exec("ROLLBACK");
            }
            catch {
                // The transaction is already closed when SQLite aborted it.
            }
            throw error;
        }
        return { ok: true };
    },
    "identity.override": (input) => {
        const kind = field(input, "kind");
        if (kind !== "merge" && kind !== "split")
            throw new Error("oc-family-pack: identity override is merge or split");
        const sources = arrayField(input, "sources").map((source) => ({ calendarKey: field(source, "calendarKey"), eventId: field(source, "eventId") }));
        if (sources.length < 2 || sources.length > 16)
            throw new Error("oc-family-pack: an identity override names two to sixteen sources");
        db.prepare("INSERT INTO oc_family_pack_fp_override (kind, sources_json, at) VALUES (?, ?, ?)").run(kind, JSON.stringify(sources), Date.now());
        return { ok: true };
    },
};
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(input, name) {
    const value = isRecord(input) ? input[name] : undefined;
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`oc-family-pack: store call needs ${name}`);
    return value;
}
function optional(input, name) {
    const value = isRecord(input) ? input[name] : undefined;
    return typeof value === "string" ? value : null;
}
function arrayField(input, name) {
    const value = isRecord(input) ? input[name] : undefined;
    if (!Array.isArray(value))
        throw new Error(`oc-family-pack: store call needs ${name}`);
    return value.map((entry) => {
        if (!isRecord(entry))
            throw new Error(`oc-family-pack: store call needs ${name}`);
        return entry;
    });
}
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
        port.postMessage({ type: "result", id: record.id, ok: true, result: handler(record.input) });
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
