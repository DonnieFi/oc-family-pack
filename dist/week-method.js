import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { ConfigError } from "./config.js";
import { WeekInputSchema } from "./contract.js";
import { pageRole } from "./write-permissions.js";
/**
 * The host-attested Gateway profile id on the published client.
 * `preparedSessionProfile` is a lifecycle recipient, not an authorization
 * identity, so it is not read here.
 */
function gatewayProfileIdOf(client) {
    const id = client?.authenticatedUserProfile?.profileId;
    if (typeof id !== "string")
        return undefined;
    const trimmed = id.trim();
    return trimmed === "" ? undefined : trimmed;
}
/**
 * Who signed in, read only from fields the published Gateway client type
 * carries, never from request params. A Gateway-attested user (the household
 * proxy's username, trimmed and lowercased to match a roster profileId) is
 * that person. A host-attested profile id is matched separately, as
 * `gatewayProfileId`, and is not lowercased. With no proxy username, a session
 * on the shared Gateway secret (token, password, or a device token issued to
 * one) is the owner, even when the host attaches its gateway-owner profile.
 * The host refuses a proxy connection without a username, so a proxy session
 * never reaches the owner branch; the smoke proves that. Anything else is a guest.
 *
 * `usesSharedGatewayAuth` is optional on the plugin Gateway client. If a host
 * drops it, the owner falls to guest, and the smoke's device-token check fails.
 */
export function viewerOf(client) {
    const gatewayProfileId = gatewayProfileIdOf(client);
    // A proxy username is set even when it is blank. Blank is a person with no
    // login, not the shared owner: the host refuses a proxy connection that has
    // no username, and the smoke proves that.
    if (client?.authenticatedUserId !== undefined) {
        const username = client.authenticatedUserId.trim().toLowerCase() || undefined;
        return gatewayProfileId === undefined ? { kind: "person", username } : { kind: "person", username, gatewayProfileId };
    }
    // A token, password, or device token has no proxy username. This host still
    // attaches its gateway-owner profile to that session. The profile is not a
    // household person, and it does not replace the shared owner.
    if (client?.usesSharedGatewayAuth === true)
        return { kind: "owner" };
    if (gatewayProfileId !== undefined)
        return { kind: "person", username: undefined, gatewayProfileId };
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
