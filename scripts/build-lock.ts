import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Serialize publishers, and recover a lock whose owner process has exited. */
export function acquireBuildLock(path: string): () => void {
  const owner = join(path, "owner");
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovery = `${path}.recovery`;
    try { mkdirSync(recovery); }
    catch { throw new Error("Build lock recovery is already running; retry after it finishes."); }
    try {
    let stale = false;
    try {
      const pid = Number(readFileSync(owner, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid build lock owner");
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") stale = true;
        else throw probe;
      }
    } catch (probe) {
      // Allow a new owner time to write its pid; recover an interrupted creation later.
      if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
      stale = Date.now() - statSync(path).mtimeMs > 30_000;
    }
    if (!stale) throw new Error("A plugin build is already running.");
    rmSync(path, { recursive: true });
    mkdirSync(path);
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  try { writeFileSync(owner, String(process.pid), { flag: "wx" }); }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  return () => {
    if (readFileSync(owner, "utf8") === String(process.pid)) rmSync(path, { recursive: true });
  };
}
