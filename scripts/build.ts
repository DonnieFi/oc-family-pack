// Build a complete candidate without deleting the assets used by a running Gateway.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const lock = join(root, ".family-build-lock");
mkdirSync(lock);
const stage = mkdtempSync(join(tmpdir(), "ocfp-build-"));
try {
  for (const name of ["src", "scripts", "package.json", "openclaw.plugin.json", "tsconfig.json", "tsconfig.build.json"]) cpSync(join(root, name), join(stage, name), { recursive: true });
  execFileSync("tsc", ["-p", join(root, "tsconfig.build.json"), "--outDir", join(stage, "dist")], { stdio: "inherit" });
  // The candidate uses the existing pinned toolchain, not a new installation.
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "dir");
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "scripts/isolated-openclaw.ts"), "openclaw", "plugins", "build"], { cwd: stage, stdio: "inherit" });
  cpSync(join(stage, "dist"), join(root, "dist"), { recursive: true });
  // Publish the manifest last; preserve previous hashed UI assets for existing clients.
  const target = join(root, "openclaw.plugin.json");
  writeFileSync(`${target}.next`, readFileSync(join(stage, "openclaw.plugin.json")));
  renameSync(`${target}.next`, target);
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(lock, { recursive: true, force: true });
}
