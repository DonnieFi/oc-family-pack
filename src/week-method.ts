import { ErrorCodes, errorShape, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { ConfigError } from "./config.ts";
import { WeekInputSchema } from "./contract.ts";
import type { WeekPayload } from "./types.ts";
import type { Viewer } from "./visibility.ts";
import { pageRole } from "./write-permissions.ts";
import { isRosterParent } from "./visibility.ts";
import type { Config } from "./types.ts";

type Client = GatewayRequestHandlerOptions["client"];

/**
 * The host-attested Gateway profile id on the published client.
 * `preparedSessionProfile` is a lifecycle recipient, not an authorization
 * identity, so it is not read here.
 */
function gatewayProfileIdOf(client: Client | undefined): string | undefined {
  const id = client?.authenticatedUserProfile?.profileId;
  if (typeof id !== "string") return undefined;
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
export function viewerOf(client: Client | undefined, accessMode?: "solo" | "lan"): Viewer {
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
  if (client?.usesSharedGatewayAuth === true) {
    // In LAN mode a paired device token is not a person and must not become the
    // shared owner. The operator can still use the password/token CLI.
    if (accessMode === "lan" && client.isDeviceTokenAuth === true) return { kind: "person", username: undefined };
    return { kind: "owner" };
  }
  return { kind: "person", username: undefined };
}

/** Whether the page shows edit controls: the same scope rule as the write gate, from the connection's granted scopes. */
export function canEditOf(client: Client | undefined): boolean {
  return pageRole({ scopes: client?.connect?.scopes ?? [] }) === "parent";
}

/** Page edit controls require both the scope and a roster parent (or owner). */
export function canEditFor(config: Pick<Config, "members" | "demo" | "accessMode">, client: Client | undefined): boolean {
  return canEditOf(client) && isRosterParent(config, viewerOf(client, config.accessMode));
}

/** The `family.week` Gateway method: the week, filtered for whoever is asking. */
export function weekMethod(
  week: (input: { start?: string }, viewer: Viewer, canEdit: boolean) => Promise<WeekPayload>,
  config: Pick<Config, "members" | "demo" | "accessMode">,
) {
  return async ({ params, client, respond }: Pick<GatewayRequestHandlerOptions, "params" | "client" | "respond">): Promise<void> => {
    if (!Value.Check(WeekInputSchema, params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.week takes only an optional start date"));
      return;
    }
    try {
      respond(true, await week(params, viewerOf(client, config.accessMode), canEditFor(config, client)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(false, undefined, errorShape(error instanceof ConfigError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, message));
    }
  };
}
