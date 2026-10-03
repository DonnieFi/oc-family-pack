import type { RunGog } from "./calendar-gog.ts";
import { grantFromAuthList, READONLY_GRANT } from "./gog-setup.ts";

/** Whether gog's Google grant can write to Calendar. `unknown` lets a write through. */
export type Grant = "read-write" | "read-only" | "unknown";

export type GrantHolder = {
  get(): Grant;
  /** Re-reads `gog auth list`. Only a definite answer changes the status; a failed or unclear read leaves it. */
  refresh(runGog: RunGog, gogPath: string): Promise<void>;
  /** A gog write failed. Only gog's read-only grant error flips the status; any other failure leaves it. */
  noteWriteFailure(error: unknown): void;
};

/** gog's stderr only: execFile's message repeats the argv, and an event title must never flip the grant. */
function stderrOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}

/** In memory only: a Gateway restart starts at `unknown` and the first calendar-watch poll fills it in. */
export function grantHolder(initial: Grant = "unknown"): GrantHolder {
  let current = initial;
  return {
    get: () => current,
    async refresh(runGog, gogPath) {
      try {
        const seen = grantFromAuthList((await runGog(gogPath, ["auth", "list", "--json", "--no-input"])).stdout);
        if (seen !== "unknown") current = seen;
      } catch {
        // A failed read says nothing about the grant.
      }
    },
    noteWriteFailure(error) {
      if (READONLY_GRANT.test(stderrOf(error))) current = "read-only";
    },
  };
}

/** The Gateway's one holder: calendar-watch refreshes it and calendar writes read it. */
export const familyGrant = grantHolder();
