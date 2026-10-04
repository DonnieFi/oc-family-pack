import { Worker } from "node:worker_threads";
export const STORE_CLOSE_TIMEOUT_MS = 5000;
export function openFamilyStore(options) {
    return openSession(options);
}
function defaultSchedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function asError(error) {
    return error instanceof Error ? error : new Error(errorMessage(error));
}
async function openSession(options) {
    const closeTimeoutMs = options.closeTimeoutMs ?? STORE_CLOSE_TIMEOUT_MS;
    const schedule = options.schedule ?? defaultSchedule;
    let phase = "idle";
    let opening = null;
    let current;
    let readyInfo;
    let nextFault = options.fault;
    let spawnedCount = 0;
    let nextId = 0;
    let generation = 0;
    let generationFailed = false;
    let stopping = false;
    let stopPromise;
    let resolveOpen;
    let rejectOpen;
    const pending = new Map();
    function warnUnknown(unknown) {
        if (unknown.length === 0)
            return;
        const message = `oc-family-pack: schema has migration ids this build does not include (${unknown.join(", ")}). The store will keep serving.`;
        if (options.logger)
            options.logger.warn(message);
        else
            console.warn(message);
    }
    function rejectPending(error) {
        for (const entry of pending.values())
            entry.reject(error);
        pending.clear();
    }
    function failGeneration(error, mine, worker) {
        if (mine !== generation || generationFailed || stopping)
            return;
        generationFailed = true;
        phase = "dead";
        const failure = asError(error);
        if (current === worker)
            current = undefined;
        rejectPending(failure);
        rejectOpen?.(failure);
        options.logger?.error?.(`oc-family-pack: family store worker failed: ${failure.message}`);
        options.reportFailure?.(failure);
        void worker.terminate().catch(() => undefined);
    }
    function handleMessage(message) {
        if (!message || typeof message !== "object")
            return;
        const record = message;
        if (record.type === "ready") {
            const ready = readReady(record);
            if (!ready) {
                const worker = current;
                if (worker)
                    failGeneration(new Error("oc-family-pack: store worker sent an unreadable ready message"), generation, worker);
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
            if (!entry)
                return;
            pending.delete(record.id);
            if (record.ok === true)
                entry.resolve(record.result);
            else
                entry.reject(new Error(typeof record.error === "string" ? record.error : "store worker call failed"));
        }
    }
    function spawnWorker() {
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
            if (mine !== generation)
                return;
            handleMessage(message);
        });
        current = worker;
        options.onWorker?.(worker);
        opening = new Promise((resolve, reject) => {
            resolveOpen = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            rejectOpen = (error) => {
                if (settled)
                    return;
                settled = true;
                reject(asError(error));
            };
        });
        const pendingOpen = opening;
        void pendingOpen.then(() => {
            phase = "ready";
        }, () => {
            if (phase !== "stopped")
                phase = "dead";
        }).finally(() => {
            if (opening === pendingOpen)
                opening = null;
        });
        return pendingOpen;
    }
    function ensureOpen() {
        if (phase === "stopped" || stopping)
            return Promise.reject(new Error("oc-family-pack: family store is stopped"));
        if (phase === "ready" && current)
            return Promise.resolve();
        if (opening)
            return opening;
        return spawnWorker();
    }
    function post(op, input) {
        const worker = current;
        if (!worker || phase !== "ready")
            return Promise.reject(new Error("oc-family-pack: family store is not ready"));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, op, input });
            }
            catch (error) {
                pending.delete(id);
                reject(asError(error));
            }
        });
    }
    const api = {
        get ready() {
            if (!readyInfo)
                throw new Error("oc-family-pack: family store is not ready");
            return readyInfo;
        },
        async status() {
            await ensureOpen();
            return (await post("store.status", {}));
        },
        async countCommittedWrites(baseKey) {
            await ensureOpen();
            return (await post("writeLog.countCommitted", { baseKey }));
        },
        async committedWrite(requestKey) {
            await ensureOpen();
            return (await post("writeLog.committed", { requestKey })) ?? undefined;
        },
        async appendWriteLog(row, { ifAbsent }) {
            await ensureOpen();
            return (await post("writeLog.append", { row, ifAbsent }));
        },
        stop() {
            if (stopPromise)
                return stopPromise;
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
                let timer = { cancel() { } };
                const finish = () => {
                    if (finished)
                        return;
                    finished = true;
                    timer.cancel();
                    resolve();
                };
                worker.once("exit", finish);
                timer = schedule(() => {
                    void worker.terminate();
                }, closeTimeoutMs);
                try {
                    worker.postMessage({ type: "close" });
                }
                catch {
                    void worker.terminate();
                }
            });
            return stopPromise;
        },
        spawned: () => spawnedCount,
    };
    await ensureOpen();
    return api;
}
function readReady(record) {
    if (!Array.isArray(record.appliedNow) || !Array.isArray(record.applied) || !Array.isArray(record.unknown))
        return undefined;
    if (typeof record.sqliteVersion !== "string" || typeof record.journalMode !== "string")
        return undefined;
    if (typeof record.nodeVersion !== "string" || record.isMainThread !== false)
        return undefined;
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
