import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { acquireBuildLock } from "./build-lock.ts";

test("a live build excludes another publisher; an exited owner permits recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "ocfp-lock-test-"));
  const lock = join(root, "lock");
  try {
    const release = acquireBuildLock(lock);
    assert.throws(() => acquireBuildLock(lock), /already running/);
    release();
    // Deliberately exit without cleanup, equivalent to a terminated build owner.
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {acquireBuildLock} from ${JSON.stringify(new URL('./build-lock.ts', import.meta.url).href)}; acquireBuildLock(${JSON.stringify(lock)});`]);
    acquireBuildLock(lock)();
    mkdirSync(lock);
    assert.throws(() => acquireBuildLock(lock), /already running/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    acquireBuildLock(lock)();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent recoverers cannot both publish", async () => {
  const { execFile } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ocfp-lock-race-"));
  const lock = join(root, "lock");
  const module = JSON.stringify(new URL("./build-lock.ts", import.meta.url).href);
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {acquireBuildLock} from ${module}; acquireBuildLock(${JSON.stringify(lock)});`]);
    const run = () => new Promise<number>((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", `import {acquireBuildLock} from ${module}; let release; try { release=acquireBuildLock(${JSON.stringify(lock)}); } catch { process.exit(2); } setTimeout(()=>{release();},1000);`], (error) => {
        if (!error) resolve(0);
        else if (error.code === 2) resolve(2);
        else reject(error);
      });
    });
    assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
