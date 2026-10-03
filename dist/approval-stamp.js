import crypto from "node:crypto";
/**
 * The one tool parameter the before_tool_call hook writes and the calendar tools read. It is
 * not in any tool schema the model sees, the hook overwrites it on every call, and the tool
 * strips it before deriving the key, so it is never hashed, stamped on an event, or logged.
 */
export const STAMP_PARAM = "ocfpStamp";
const DECISIONS = ["write", "approved"];
/** A fixed-order JSON array, so no field can run into the next. */
function message(base, decision, tool) {
    return JSON.stringify(["ocfp-stamp-v1", tool, decision, base]);
}
/**
 * HMAC-SHA256 under a secret made when the plugin registers. The secret lives in this closure
 * only: never logged, never in config or the database. A Gateway restart makes a new one, so a
 * stamp never outlives the process that made it.
 */
export function createStamper(secret = crypto.randomBytes(32)) {
    const mac = (base, decision, tool) => crypto.createHmac("sha256", secret).update(message(base, decision, tool)).digest("hex");
    return {
        stamp: mac,
        verify(value, base, tool) {
            if (typeof value !== "string")
                return undefined;
            const given = Buffer.from(value, "utf8");
            for (const decision of DECISIONS) {
                const expected = Buffer.from(mac(base, decision, tool), "utf8");
                // timingSafeEqual throws on a length mismatch, so a wrong-length stamp stops here.
                if (given.length !== expected.length)
                    return undefined;
                if (crypto.timingSafeEqual(given, expected))
                    return decision;
            }
            return undefined;
        },
    };
}
