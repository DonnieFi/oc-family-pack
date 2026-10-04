import { grantFromAuthList, READONLY_GRANT } from "./gog-setup.js";
/** gog's stderr only: execFile's message repeats the argv, and an event title must never flip the grant. */
export function stderrOf(error) {
    if (typeof error !== "object" || error === null)
        return "";
    const stderr = error.stderr;
    return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}
/** Whether a failed gog write is gog's read-only grant error, read from its stderr only. */
export function isReadOnlyGrantError(error) {
    return READONLY_GRANT.test(stderrOf(error));
}
/** In memory only: a Gateway restart starts at `unknown` and the first calendar-watch poll fills it in. */
export function grantHolder(initial = "unknown") {
    let current = initial;
    let lastSource = "initial";
    /** The one write path for the status. */
    const set = (next, from) => {
        current = next;
        lastSource = from;
    };
    return {
        get: () => current,
        source: () => lastSource,
        async refresh(runGog, gogPath) {
            try {
                const seen = grantFromAuthList((await runGog(gogPath, ["auth", "list", "--json", "--no-input"])).stdout);
                if (seen !== "unknown")
                    set(seen, "poll");
            }
            catch {
                // A failed read says nothing about the grant.
            }
        },
        noteWriteFailure(error) {
            if (!isReadOnlyGrantError(error))
                return false;
            set("read-only", "write-failure");
            return true;
        },
    };
}
/** The Gateway's one holder: calendar-watch refreshes it and calendar writes read it. */
export const familyGrant = grantHolder();
