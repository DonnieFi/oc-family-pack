import { Worker } from "node:worker_threads";
import type { IdentityBook, IdentityOverride, IdentityPatch, IdentitySource, LegacyRef } from "./identity.ts";
import type { ReminderMode } from "./types.ts";

export const STORE_CLOSE_TIMEOUT_MS = 5000;

export type StoreFault = "startup" | "call" | "hang-close" | "journal";

export type StoreReady = {
  appliedNow: string[];
  applied: string[];
  unknown: string[];
  sqliteVersion: string;
  journalMode: string;
  isMainThread: false;
  nodeVersion: string;
};

export type StoreStatus = {
  isMainThread: false;
  threadId: number;
  scriptUrl: string;
  nodeVersion: string;
  sqliteVersion: string;
  journalMode: string;
  applied: string[];
  unknown: string[];
};

export type WriteStatus = "committed" | "failed" | "denied" | "timed-out" | "reverted";

/** One write-log row as the caller sends it; the worker stamps `at`. `beforeJson` and `afterJson` are JSON text. */
export type WriteLogRow = {
  requestKey: string;
  baseKey: string;
  requester: string;
  op: "create" | "update" | "move" | "delete";
  calendarId: string;
  eventId?: string;
  beforeJson?: string;
  afterJson?: string;
  status: WriteStatus;
};

export type DeliveryKind = "daily" | "weekly" | "reminder" | "household" | "alert";
export type DeliveryStatus = "sent" | "partial" | "failed" | "held" | "unknown";

/** One delivery-log row as the caller sends it; the worker stamps `at` and returns the row id. */
export type DeliveryLogRow = {
  deliveryKey: string;
  kind: DeliveryKind;
  /** A member id or a channels key, never a Discord id. */
  target: string;
  /** Which namespace target belongs to; older rows omit it. */
  targetKind?: "member" | "channel";
  status: DeliveryStatus;
  errorKind?: "no-permission" | "no-channel" | "other";
  /** Why it was not sent, at most 200 characters. Never shown to the family. */
  errorDetail?: string;
  receiptJson?: string;
};

/** What the log kept of a committed write: enough to answer a retry without asking Google again. */
export type CommittedWrite = { eventId: string | null; beforeJson: string | null; afterJson: string | null };

export type FamilyStore = {
  ready: StoreReady;
  status: () => Promise<StoreStatus>;
  countCommittedWrites: (baseKey: string) => Promise<number>;
  /** The committed row for one request key, if there is one. */
  committedWrite: (requestKey: string) => Promise<CommittedWrite | undefined>;
  /** `ifAbsent` is INSERT OR IGNORE, for a write found already done; otherwise a plain INSERT. */
  appendWriteLog: (row: WriteLogRow, options: { ifAbsent: boolean }) => Promise<{ inserted: boolean }>;
  appendDeliveryLog: (row: DeliveryLogRow) => Promise<{ id: number }>;
  /** True when the key has a sent, partial, held or unknown row: it is never sent again. */
  deliveryDone: (deliveryKey: string) => Promise<boolean>;
  /** The first row that was not sent since the last sent row for (kind, target), if any. */
  deliveryStreakStart: (kind: DeliveryKind, target: string) => Promise<{ id: number; status: DeliveryStatus } | undefined>;
  /** The newest delivery row. The page matches `target` to a roster profile id and does not show it. */
  latestDelivery: () => Promise<{ kind: DeliveryKind; status: DeliveryStatus; target: string; targetKind?: "member" | "channel" } | undefined>;
  /** Records a chat change of one person's reminder mode. The latest row wins. */
  appendReminderMode: (profileId: string, mode: ReminderMode) => Promise<{ id: number }>;
  /** The latest saved mode for each person who has changed it. */
  reminderModes: () => Promise<Record<string, ReminderMode>>;
  /** True after Today has been placed on Home once. */
  homeSeeded: () => Promise<boolean>;
  /** Records that placement. A second call inserts nothing. */
  claimHomeSeed: () => Promise<{ inserted: boolean }>;
  /** The durable event-identity book. Sources absent from the latest read stay here. */
  identityBook: () => Promise<IdentityBook>;
  /** Upserts source bindings and legacy wire ids. An empty patch writes nothing. */
  rememberIdentity: (patch: IdentityPatch) => Promise<void>;
  /** Remembers a manual merge or split. The next read applies it. */
  recordIdentityOverride: (kind: IdentityOverride["kind"], sources: IdentityOverride["sources"]) => Promise<void>;
  stop: () => Promise<void>;
  spawned: () => number;
};

type Logger = {
  warn: (message: string) => void;
  error?: (message: string) => void;
  info?: (message: string) => void;
};

type Schedule = (fn: () => void, ms: number) => { cancel: () => void };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export function openFamilyStore(options: {
  stateDir: string;
  fault?: StoreFault;
  reportFailure?: (error: unknown) => void;
  logger?: Logger;
  closeTimeoutMs?: number;
  schedule?: Schedule;
  onWorker?: (worker: Worker) => void;
}): Promise<FamilyStore> {
  return openSession(options);
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

async function openSession(options: {
  stateDir: string;
  fault?: StoreFault;
  reportFailure?: (error: unknown) => void;
  logger?: Logger;
  closeTimeoutMs?: number;
  schedule?: Schedule;
  onWorker?: (worker: Worker) => void;
}): Promise<FamilyStore> {
  const closeTimeoutMs = options.closeTimeoutMs ?? STORE_CLOSE_TIMEOUT_MS;
  const schedule = options.schedule ?? defaultSchedule;
  let phase: "idle" | "opening" | "ready" | "dead" | "stopped" = "idle";
  let opening: Promise<void> | null = null;
  let current: Worker | undefined;
  let readyInfo: StoreReady | undefined;
  let nextFault = options.fault;
  let spawnedCount = 0;
  let nextId = 0;
  let generation = 0;
  let generationFailed = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let resolveOpen: (() => void) | undefined;
  let rejectOpen: ((error: unknown) => void) | undefined;
  const pending = new Map<number, Pending>();

  function warnUnknown(unknown: string[]): void {
    if (unknown.length === 0) return;
    const message = `oc-family-pack: schema has migration ids this build does not include (${unknown.join(", ")}). The store will keep serving.`;
    if (options.logger) options.logger.warn(message);
    else console.warn(message);
  }

  function rejectPending(error: Error): void {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function failGeneration(error: unknown, mine: number, worker: Worker): void {
    if (mine !== generation || generationFailed || stopping) return;
    generationFailed = true;
    phase = "dead";
    const failure = asError(error);
    if (current === worker) current = undefined;
    rejectPending(failure);
    rejectOpen?.(failure);
    options.logger?.error?.(`oc-family-pack: family store worker failed: ${failure.message}`);
    options.reportFailure?.(failure);
    void worker.terminate().catch(() => undefined);
  }

  function handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "ready") {
      const ready = readReady(record);
      if (!ready) {
        const worker = current;
        if (worker) failGeneration(new Error("oc-family-pack: store worker sent an unreadable ready message"), generation, worker);
        return;
      }
      readyInfo = ready;
      warnUnknown(ready.unknown);
      phase = "ready";
      resolveOpen?.();
      return;
    }
    if (record.type === "result" && typeof record.id === "number") {
      const entry = pending.get(record.id);
      if (!entry) return;
      pending.delete(record.id);
      if (record.ok === true) entry.resolve(record.result);
      else entry.reject(new Error(typeof record.error === "string" ? record.error : "store worker call failed"));
    }
  }

  function spawnWorker(): Promise<void> {
    phase = "opening";
    const mine = ++generation;
    generationFailed = false;
    const fault = nextFault;
    nextFault = undefined;
    spawnedCount += 1;
    let settled = false;
    const worker = new Worker(new URL("./store-worker.js", import.meta.url), {
      workerData: { stateDir: options.stateDir, ...(fault ? { fault } : {}) },
    });
    worker.on("error", (error) => failGeneration(error, mine, worker));
    worker.on("exit", (code) => {
      // The error event is delivered first. Wait a turn so a crash reports that
      // error instead of a bare exit code. A later worker has a new generation,
      // so this exit cannot fail the replacement.
      setImmediate(() => {
        failGeneration(new Error(`oc-family-pack: family store worker exited (${code})`), mine, worker);
      });
    });
    worker.on("message", (message) => {
      if (mine !== generation) return;
      handleMessage(message);
    });
    current = worker;
    options.onWorker?.(worker);
    opening = new Promise<void>((resolve, reject) => {
      resolveOpen = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rejectOpen = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(asError(error));
      };
    });
    const pendingOpen = opening;
    void pendingOpen.then(
      () => {
        phase = "ready";
      },
      () => {
        if (phase !== "stopped") phase = "dead";
      },
    ).finally(() => {
      if (opening === pendingOpen) opening = null;
    });
    return pendingOpen;
  }

  function ensureOpen(): Promise<void> {
    if (phase === "stopped" || stopping) return Promise.reject(new Error("oc-family-pack: family store is stopped"));
    if (phase === "ready" && current) return Promise.resolve();
    if (opening) return opening;
    return spawnWorker();
  }

  function post(op: string, input: unknown): Promise<unknown> {
    const worker = current;
    if (!worker || phase !== "ready") return Promise.reject(new Error("oc-family-pack: family store is not ready"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, op, input });
      } catch (error) {
        pending.delete(id);
        reject(asError(error));
      }
    });
  }

  const api: FamilyStore = {
    get ready() {
      if (!readyInfo) throw new Error("oc-family-pack: family store is not ready");
      return readyInfo;
    },
    async status() {
      await ensureOpen();
      return (await post("store.status", {})) as StoreStatus;
    },
    async countCommittedWrites(baseKey) {
      await ensureOpen();
      return (await post("writeLog.countCommitted", { baseKey })) as number;
    },
    async committedWrite(requestKey) {
      await ensureOpen();
      return ((await post("writeLog.committed", { requestKey })) as CommittedWrite | null) ?? undefined;
    },
    async appendWriteLog(row, { ifAbsent }) {
      await ensureOpen();
      return (await post("writeLog.append", { row, ifAbsent })) as { inserted: boolean };
    },
    async appendDeliveryLog(row) {
      await ensureOpen();
      return (await post("deliveryLog.append", { row })) as { id: number };
    },
    async deliveryDone(deliveryKey) {
      await ensureOpen();
      return (await post("deliveryLog.done", { deliveryKey })) === true;
    },
    async deliveryStreakStart(kind, target) {
      await ensureOpen();
      return ((await post("deliveryLog.streakStart", { kind, target })) as { id: number; status: DeliveryStatus } | null) ?? undefined;
    },
    async latestDelivery() {
      await ensureOpen();
      return readLatestDelivery(await post("deliveryLog.latest", {}));
    },
    async appendReminderMode(profileId, mode) {
      await ensureOpen();
      return (await post("reminderMode.append", { profileId, mode })) as { id: number };
    },
    async reminderModes() {
      await ensureOpen();
      return (await post("reminderMode.latest", {})) as Record<string, ReminderMode>;
    },
    async homeSeeded() {
      await ensureOpen();
      return (await post("home.seeded", {})) === true;
    },
    async claimHomeSeed() {
      await ensureOpen();
      return (await post("home.claim", {})) as { inserted: boolean };
    },
    async identityBook() {
      await ensureOpen();
      return readIdentityBook(await post("identity.book", {}));
    },
    async rememberIdentity(patch) {
      await ensureOpen();
      if (!patch.dirty) return;
      await post("identity.remember", { sources: patch.sources, legacy: patch.legacy, dropLegacy: patch.dropLegacy });
    },
    async recordIdentityOverride(kind, sources) {
      await ensureOpen();
      await post("identity.override", { kind, sources });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      phase = "stopped";
      rejectPending(new Error("oc-family-pack: family store is stopping"));
      const worker = current;
      current = undefined;
      stopPromise = new Promise((resolve) => {
        if (!worker) {
          resolve();
          return;
        }
        let finished = false;
        let timer: { cancel: () => void } = { cancel() {} };
        const finish = () => {
          if (finished) return;
          finished = true;
          timer.cancel();
          resolve();
        };
        worker.once("exit", finish);
        timer = schedule(() => {
          void worker.terminate().catch(() => undefined);
        }, closeTimeoutMs);
        try {
          worker.postMessage({ type: "close" });
        } catch {
          void worker.terminate().catch(() => undefined);
        }
      });
      return stopPromise;
    },
    spawned: () => spawnedCount,
  };

  await ensureOpen();
  return api;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readIdentityBook(value: unknown): IdentityBook {
  const empty: IdentityBook = { sources: [], overrides: [], legacy: [] };
  if (!value || typeof value !== "object") return empty;
  const record = value as { sources?: unknown; overrides?: unknown; legacy?: unknown };
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap((entry): IdentitySource[] => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as { calendarKey?: unknown; eventId?: unknown; fpId?: unknown; iCalUid?: unknown; seriesId?: unknown; occurrence?: unknown };
        if (typeof row.calendarKey !== "string" || typeof row.eventId !== "string" || typeof row.fpId !== "string") return [];
        const iCalUid = optionalText(row.iCalUid);
        const seriesId = optionalText(row.seriesId);
        const occurrence = optionalText(row.occurrence);
        return [{
          calendarKey: row.calendarKey,
          eventId: row.eventId,
          fpId: row.fpId,
          ...(iCalUid ? { iCalUid } : {}),
          ...(seriesId ? { seriesId } : {}),
          ...(occurrence ? { occurrence } : {}),
        }];
      })
    : [];
  const overrides = Array.isArray(record.overrides)
    ? record.overrides.flatMap((entry): IdentityOverride[] => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as { kind?: unknown; sources?: unknown };
        if ((row.kind !== "merge" && row.kind !== "split") || !Array.isArray(row.sources)) return [];
        const sources = row.sources.flatMap((source): { calendarKey: string; eventId: string }[] => {
          if (!source || typeof source !== "object") return [];
          const item = source as { calendarKey?: unknown; eventId?: unknown };
          if (typeof item.calendarKey !== "string" || typeof item.eventId !== "string" || item.calendarKey === "" || item.eventId === "") return [];
          return [{ calendarKey: item.calendarKey, eventId: item.eventId }];
        });
        return sources.length >= 2 ? [{ kind: row.kind, sources }] : [];
      })
    : [];
  const legacy = Array.isArray(record.legacy)
    ? record.legacy.flatMap((entry): LegacyRef[] => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as { fpId?: unknown; ref?: unknown };
        if (typeof row.fpId !== "string" || typeof row.ref !== "string" || row.fpId === "" || row.ref === "") return [];
        return [{ fpId: row.fpId, ref: row.ref }];
      })
    : [];
  return { sources, overrides, legacy };
}

function readLatestDelivery(
  value: unknown,
): { kind: DeliveryKind; status: DeliveryStatus; target: string; targetKind?: "member" | "channel" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  const status = (value as { status?: unknown }).status;
  const target = (value as { target?: unknown }).target;
  const targetKind = (value as { targetKind?: unknown }).targetKind;
  if (
    (kind !== "daily" && kind !== "weekly" && kind !== "reminder" && kind !== "household" && kind !== "alert") ||
    (status !== "sent" && status !== "partial" && status !== "failed" && status !== "held" && status !== "unknown") ||
    typeof target !== "string" ||
    target === "" ||
    (targetKind !== undefined && targetKind !== "member" && targetKind !== "channel")
  ) {
    return undefined;
  }
  return { kind, status, target, ...(targetKind !== undefined ? { targetKind } : {}) };
}

function readReady(record: Record<string, unknown>): StoreReady | undefined {
  if (!Array.isArray(record.appliedNow) || !Array.isArray(record.applied) || !Array.isArray(record.unknown)) return undefined;
  if (typeof record.sqliteVersion !== "string" || typeof record.journalMode !== "string") return undefined;
  if (typeof record.nodeVersion !== "string" || record.isMainThread !== false) return undefined;
  return {
    appliedNow: record.appliedNow.map(String),
    applied: record.applied.map(String),
    unknown: record.unknown.map(String),
    sqliteVersion: record.sqliteVersion,
    journalMode: record.journalMode,
    isMainThread: false,
    nodeVersion: record.nodeVersion,
  };
}
