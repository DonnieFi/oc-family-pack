import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { CalendarWriteSchema } from "./contract.js";
import { isRosterParent, memberForViewer } from "./visibility.js";
import { VIEW_ONLY } from "./write-gate.js";
import { viewerOf } from "./week-method.js";
/**
 * The page's only write entry. A session action carries no signed-in person,
 * so the page calls a Gateway method that resolves the viewer, checks the
 * roster parent role and then runs the one write pipeline.
 */
export function pageWriteMethod(config, write) {
    return async ({ params, client, respond }) => {
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
        const requester = {
            from: "page",
            role: "parent",
            ...(member !== undefined ? { memberId: member.id } : {}),
            client: { scopes: ["operator.write"] },
        };
        const context = {
            source: "session-action",
            action: { client: { scopes: ["operator.write"] } },
        };
        try {
            respond(true, await write(params, context, requester, viewer));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
    };
}
