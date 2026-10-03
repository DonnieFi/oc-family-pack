import { grantFromAuthList, READONLY_GRANT } from "./gog-setup.js";
/** gog's stderr only: execFile's message repeats the argv, and an event title must never flip the grant. */
function stderrOf(error) {
    if (typeof error !== "object" || error === null)
        return "";
    const stderr = error.stderr;
    return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}
/** In memory only: a Gateway restart starts at `unknown` and the first calendar-watch poll fills it in. */
export function grantHolder(initial = "unknown") {
    let current = initial;
    return {
        get: () => current,
        async refresh(runGog, gogPath) {
            try {
                const seen = grantFromAuthList((await runGog(gogPath, ["auth", "list", "--json", "--no-input"])).stdout);
                if (seen !== "unknown")
                    current = seen;
            }
            catch {
                // A failed read says nothing about the grant.
            }
        },
        noteWriteFailure(error) {
            if (READONLY_GRANT.test(stderrOf(error)))
                current = "read-only";
        },
    };
}
/** The Gateway's one holder: calendar-watch refreshes it and calendar writes read it. */
export const familyGrant = grantHolder();
