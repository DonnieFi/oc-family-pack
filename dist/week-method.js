import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { ConfigError } from "./config.js";
import { WeekInputSchema } from "./contract.js";
import { pageRole } from "./write-permissions.js";
/**
 * Who signed in, read only from fields the published Gateway client type
 * carries, never from request params. A Gateway-attested user (the household
 * proxy's username, trimmed and lowercased to match a roster profileId) is
 * that person. With no user, a session on the shared
 * Gateway secret (token, password, or a device token issued to one) is the
 * owner, since whoever holds it runs the Gateway. The host refuses a proxy
 * connection without a username, so a proxy session never reaches the owner
 * branch; the smoke proves that. Anything else is a guest.
 *
 * `usesSharedGatewayAuth` is declared on the host's GatewayWsClient, which is
 * the object handlers receive, but not on the narrower GatewayClient type the
 * SDK hands plugins, hence the cast. If a host drops it, the owner falls to
 * guest, and the smoke's password-CLI check fails.
 */
export function viewerOf(client) {
    if (client?.authenticatedUserId !== undefined) {
        return { kind: "person", username: client.authenticatedUserId.trim().toLowerCase() || undefined };
    }
    if (client?.usesSharedGatewayAuth === true)
        return { kind: "owner" };
    return { kind: "person", username: undefined };
}
/** Whether the page shows edit controls: the same scope rule as the write gate, from the connection's granted scopes. */
export function canEditOf(client) {
    return pageRole({ scopes: client?.connect?.scopes ?? [] }) === "parent";
}
/** The `family.week` Gateway method: the week, filtered for whoever is asking. */
export function weekMethod(week) {
    return async ({ params, client, respond }) => {
        if (!Value.Check(WeekInputSchema, params)) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.week takes only an optional start date"));
            return;
        }
        try {
            respond(true, await week(params, viewerOf(client), canEditOf(client)));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            respond(false, undefined, errorShape(error instanceof ConfigError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, message));
        }
    };
}
