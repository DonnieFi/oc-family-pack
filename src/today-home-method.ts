import { ErrorCodes, errorShape, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { FamilyStore } from "./store.ts";
import type { Config } from "./types.ts";
import { isRosterParent } from "./visibility.ts";
import { viewerOf } from "./week-method.ts";

type HomeStore = Pick<FamilyStore, "homeSeeded" | "claimHomeSeed">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether Today was placed on Home once. `claim: true` records that, and only
 * an operator.write caller can reach it, so a kid cannot consume the seed.
 * A store that is not open reports unseeded and does not record a claim.
 * This file stays off the Control UI bundle: the gateway runtime is not browser-safe.
 */
export function todayHomeMethod(store: () => HomeStore | undefined, config: () => Pick<Config, "members" | "demo" | "accessMode">) {
  return async ({ params, client, respond }: Pick<GatewayRequestHandlerOptions, "params" | "client" | "respond">): Promise<void> => {
    if (!isRosterParent(config(), viewerOf(client, config().accessMode))) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "The Today card is for a parent."));
      return;
    }
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
      if (record.claim === true) await current.claimHomeSeed();
      respond(true, { seeded: await current.homeSeeded() });
    } catch {
      respond(true, { seeded: false });
    }
  };
}
