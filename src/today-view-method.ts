import { ErrorCodes, errorShape, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { TodayPayload } from "./types.ts";
import type { Viewer } from "./visibility.ts";
import { viewerOf } from "./week-method.ts";

/**
 * The Today widget's data. The agent tool family_today is a feature query and a
 * session action carries no viewer identity; this Gateway method resolves the
 * signed-in person before it builds the card.
 */
export function todayViewMethod(today: (viewer: Viewer) => Promise<TodayPayload>, accessMode?: "solo" | "lan") {
  return async ({ client, respond }: Pick<GatewayRequestHandlerOptions, "client" | "respond">): Promise<void> => {
    try {
      respond(true, await today(viewerOf(client, accessMode)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  };
}
