import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { viewerOf } from "./week-method.js";
/**
 * The Today widget's data. The agent tool family_today is a feature query and a
 * session action carries no viewer identity; this Gateway method resolves the
 * signed-in person before it builds the card.
 */
export function todayViewMethod(today, accessMode) {
    return async ({ client, respond }) => {
        try {
            respond(true, await today(viewerOf(client, accessMode)));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
    };
}
