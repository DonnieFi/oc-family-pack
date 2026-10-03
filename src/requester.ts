import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemberConfig } from "./types.ts";

/**
 * Where a call came from, read only from what the host sets: the invocation source and,
 * for a tool, its message channel. Nothing in the call's input reaches this.
 * - discord: member is the roster person with that exact discordId; no member means unmatched.
 * - tool: a tool call off Discord, where the host's owner flag is the only signal.
 * - page: a session action from the Control UI page.
 */
export type Requester =
  | { from: "discord"; member?: MemberConfig }
  | { from: "tool"; senderIsOwner: boolean }
  | { from: "page" }
  | { from: "other" };

export function resolveRequester(members: readonly MemberConfig[], context: FeatureInvocationContext): Requester {
  if (context.source === "session-action") return { from: "page" };
  if (context.source !== "tool") return { from: "other" };
  const { messageChannel, requesterSenderId, senderIsOwner } = context.tool;
  if (messageChannel === "discord") {
    const member = requesterSenderId === undefined ? undefined : members.find((entry) => entry.discordId === requesterSenderId);
    return member ? { from: "discord", member } : { from: "discord" };
  }
  return { from: "tool", senderIsOwner: senderIsOwner === true };
}
