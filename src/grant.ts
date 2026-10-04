import type { RunGog } from "./calendar-gog.ts";
import { grantFromAuthList, READONLY_GRANT } from "./gog-setup.ts";

/** Whether gog's Google grant can write to Calendar. `unknown` lets a write through. */
export type Grant = "read-write" | "read-only" | "unknown";

/** What last set the status: where the holder started, the calendar-watch poll, or a gog write refused for the grant. */
export type GrantSource = "initial" | "poll" | "write-failure";

export type GrantHolder = {
  get(): Grant;
  /** What last set the status. The poll and a write failure both go through the holder's one setter, which records it. */
  source(): GrantSource;
  /** Re-reads `gog auth list`. Only a definite answer changes the status; a failed or unclear read leaves it. */
  refresh(runGog: RunGog, gogPath: string): Promise<void>;
  /**
   * A gog write failed. Only gog's read-only grant error (the shared READONLY_GRANT matcher)
   * flips the status; any other failure leaves it. True when it was that error.
   */
  noteWriteFailure(error: unknown): boolean;
};

/** gog's stderr only: execFile's message repeats the argv, and an event title must never flip the grant. */
export function stderrOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}

/** Whether a failed gog write is gog's read-only grant error, read from its stderr only. */
export function isReadOnlyGrantError(error: unknown): boolean {
  return READONLY_GRANT.test(stderrOf(error));
}

/** In memory only: a Gateway restart starts at `unknown` and the first calendar-watch poll fills it in. */
export function grantHolder(initial: Grant = "unknown"): GrantHolder {
  let current = initial;
  let lastSource: GrantSource = "initial";
  /** The one write path for the status. */
  const set = (next: Grant, from: GrantSource) => {
    current = next;
    lastSource = from;
  };
  return {
    get: () => current,
    source: () => lastSource,
    async refresh(runGog, gogPath) {
      try {
        const seen = grantFromAuthList((await runGog(gogPath, ["auth", "list", "--json", "--no-input"])).stdout);
        if (seen !== "unknown") set(seen, "poll");
      } catch {
        // A failed read says nothing about the grant.
      }
    },
    noteWriteFailure(error) {
      if (!isReadOnlyGrantError(error)) return false;
      set("read-only", "write-failure");
      return true;
    },
  };
}

/** The Gateway's one holder: calendar-watch refreshes it and calendar writes read it. */
export const familyGrant = grantHolder();
