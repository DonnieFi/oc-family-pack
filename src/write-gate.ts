import type { Grant } from "./grant.ts";
import type { Requester } from "./requester.ts";
import type { CalendarConfig, MemberConfig, WriteMode } from "./types.ts";
import { approvers, pageRole, writeRight } from "./write-permissions.ts";

/** A page session without operator.write or operator.admin. */
export const VIEW_ONLY = "This page is view-only for you, so I didn't change anything.";
/** `writes: "off"` in the plugin config. */
export const WRITES_OFF = "Calendar changes are turned off right now, so I didn't change anything.";
/** gog's Google grant can't write to Calendar. */
export const READ_ONLY = "I can only read the calendars right now, so I didn't change anything.";

export type GateDecision = { decision: "refused"; message: string } | { decision: "needs-approval"; approvers: string[] } | { decision: "write" };

/**
 * The checks every calendar write passes before gog runs, in order:
 * 0. a page session that isn't a parent is view-only. The host already refuses
 *    operator.read before a write action runs; this is the wall behind it.
 * 1. `writes: "off"` refuses everything.
 * 2. a read-only gog grant refuses everything; `unknown` lets the write through.
 * 3. the permission table, and `writes: "confirm"` sends every write for approval.
 */
export function gateWrite(input: {
  writes: WriteMode;
  grant: Grant;
  members: readonly MemberConfig[];
  requester: Requester;
  calendar: Pick<CalendarConfig, "kind" | "owners">;
}): GateDecision {
  if (input.requester.from === "page" && pageRole(input.requester.client) !== "parent") return { decision: "refused", message: VIEW_ONLY };
  if (input.writes === "off") return { decision: "refused", message: WRITES_OFF };
  if (input.grant === "read-only") return { decision: "refused", message: READ_ONLY };
  const right = writeRight(input.members, input.requester, input.calendar);
  if (right.right === "needs-approval") return { decision: "needs-approval", approvers: right.approvers };
  if (input.writes === "confirm") return { decision: "needs-approval", approvers: approvers(input.members) };
  return { decision: "write" };
}
