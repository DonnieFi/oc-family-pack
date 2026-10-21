import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Whether Today was placed on Home once. `claim: true` records that, and only
 * an operator.write caller can reach it, so a kid cannot consume the seed.
 * A store that is not open reports unseeded and does not record a claim.
 * This file stays off the Control UI bundle: the gateway runtime is not browser-safe.
 */
export function todayHomeMethod(store) {
    return async ({ params, respond }) => {
        const record = params == null ? {} : isRecord(params) ? params : null;
        if (record === null || ("claim" in record && typeof record.claim !== "boolean")) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.todayHome takes an optional claim flag"));
            return;
        }
        try {
            const current = store();
            if (!current) {
                respond(true, { seeded: false });
                return;
            }
            if (record.claim === true)
                await current.claimHomeSeed();
            respond(true, { seeded: await current.homeSeeded() });
        }
        catch {
            respond(true, { seeded: false });
        }
    };
}
