import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { ErrorCodes, errorShape, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { CalendarWriteSchema } from "./contract.ts";
import type { PageWriteResult } from "./page-write.ts";
import type { Requester } from "./requester.ts";
import type { CalendarWrite, Config } from "./types.ts";
import { isRosterParent, memberForViewer, type Viewer } from "./visibility.ts";
import { VIEW_ONLY } from "./write-gate.ts";
import { viewerOf } from "./week-method.ts";

/**
 * The page's only write entry. A session action carries no signed-in person,
 * so the page calls a Gateway method that resolves the viewer, checks the
 * roster parent role and then runs the one write pipeline.
 */
export function pageWriteMethod(
  config: () => Config,
  write: (input: CalendarWrite, context: FeatureInvocationContext, requester: Requester, viewer: Viewer) => Promise<PageWriteResult>,
) {
  return async ({ params, client, respond }: Pick<GatewayRequestHandlerOptions, "params" | "client" | "respond">): Promise<void> => {
    if (!Value.Check(CalendarWriteSchema, params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.pageWrite takes one calendar change"));
      return;
    }
    const current = config();
    const viewer = viewerOf(client, current.accessMode);
    if (!isRosterParent(current, viewer)) {
      respond(true, { ok: false, message: VIEW_ONLY });
      return;
    }
    const member = memberForViewer(current, viewer);
    const requester: Requester = {
      from: "page",
      role: "parent",
      ...(member !== undefined ? { memberId: member.id } : {}),
      client: { scopes: ["operator.write"] },
    };
    const context = {
      source: "session-action",
      action: { client: { scopes: ["operator.write"] } },
    } as unknown as FeatureInvocationContext;
    try {
      respond(true, await write(params as CalendarWrite, context, requester, viewer));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  };
}
