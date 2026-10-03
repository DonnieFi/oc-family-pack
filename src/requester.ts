import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemberConfig } from "./types.ts";

/**
 * Where a call came from, read only from what the host sets: the invocation source and,
 * for a tool, its message channel. Nothing in the call's input reaches this.
 * - discord: member is the roster person with that exact discordId; no member means unmatched.
 * - tool: a tool call off Discord, where the host's owner flag is the only signal.
 * - page: a session action from the Control UI page. `client` is the host's copy of the
 *   connection's granted scopes, never anything from the action's payload.
 */
export type Requester =
  | { from: "discord"; member?: MemberConfig }
  | { from: "tool"; senderIsOwner: boolean }
  | { from: "page"; client?: { scopes: readonly string[] } }
  | { from: "other" };

/**
 * What the host says about a tool call's sender. The tool gets these from its tool context
 * (messageChannel, requesterSenderId, senderIsOwner) and the before_tool_call hook from its
 * requester (channel, senderId, senderIsOwner); both come from the same run options. The host
 * normalizes the tool's channel but hands the hook the raw one, so the channel is lowercased here.
 */
export type CallFacts = { channel?: string | undefined; senderId?: string | undefined; senderIsOwner?: boolean | undefined };

export function requesterFromFacts(members: readonly MemberConfig[], facts: CallFacts): Requester {
  if (facts.channel?.trim().toLowerCase() === "discord") {
    const senderId = facts.senderId;
    const member = senderId === undefined ? undefined : members.find((entry) => entry.discordId === senderId);
    return member ? { from: "discord", member } : { from: "discord" };
  }
  return { from: "tool", senderIsOwner: facts.senderIsOwner === true };
}

/**
 * Who asked for a calendar write, as the host knows it. Discord only when the host gave both the
 * discord channel and a sender id: the sender id comes only from the host's own inbound adapter
 * (openclaw c074824 agent-tools-D5UK6LHM.mjs:649, :828-834 from the run's senderId), or from a
 * restart resuming such a run (agent-turn-service-Gu0_gTsb.mjs:3414-3417). A caller can set the
 * channel without one: the agent RPC `channel` param (src-BvzgK7Oj.mjs:2946, agent-turn-service
 * :1545-1553), the OpenAI-compatible HTTP x-openclaw-message-channel header (http-utils
 * -C0LN6liV.mjs:185), the MCP HTTP header (mcp-http-DYo0UIm8.mjs:232) and the /tools/invoke
 * header (tools-invoke-http-DsV9C_z1.mjs:52). None of those paths has a sender field, so a
 * channel without a sender is `tool`, never `discord:unmatched`: the write log names who the
 * host knows asked, not what the caller claimed. The hook and the tool both use this, so their
 * keys match.
 */
export function writeRequesterFromFacts(members: readonly MemberConfig[], facts: CallFacts): Requester {
  const senderId = facts.senderId?.trim() ? facts.senderId : undefined;
  if (facts.channel?.trim().toLowerCase() === "discord" && senderId !== undefined) {
    const member = members.find((entry) => entry.discordId === senderId);
    return member ? { from: "discord", member } : { from: "discord" };
  }
  return { from: "tool", senderIsOwner: facts.senderIsOwner === true };
}

/** The tool-context fields a calendar write reads (plugin-sdk OpenClawPluginToolContext). */
export type ToolCallContext = {
  messageChannel?: string | undefined;
  requesterSenderId?: string | undefined;
  senderIsOwner?: boolean | undefined;
  conversationReadOrigin?: string | undefined;
};

/**
 * What a calendar write may believe about a tool call's sender. The host marks every HTTP
 * /tools/invoke call `conversationReadOrigin: "direct-operator"` (openclaw c074824
 * tools-invoke-http-DsV9C_z1.mjs:89), and that call's messageChannel and account come from the
 * caller's own x-openclaw-* headers (:52-55), so it is always `tool`. Agent runs never carry the
 * mark (they leave it unset, which the host reads as "delegated"); WS tools.invoke can ask for it
 * but has no channel or sender to give (its params are a closed schema), so asking only makes
 * it `tool` too. The before_tool_call hook has no such fields on either invoke path: it reads
 * only the requester the host sets on an agent run.
 */
export function toolWriteFacts(tool: ToolCallContext): CallFacts {
  if (tool.conversationReadOrigin === "direct-operator") return { senderIsOwner: tool.senderIsOwner };
  return { channel: tool.messageChannel, senderId: tool.requesterSenderId, senderIsOwner: tool.senderIsOwner };
}

/**
 * The requester for a calendar write: a page's client scopes, or a tool call read through
 * toolWriteFacts and writeRequesterFromFacts. Reads (family_schedule) keep resolveRequester, where a caller-set Discord
 * header can only make the caller a guest.
 */
export function resolveWriteRequester(members: readonly MemberConfig[], context: FeatureInvocationContext): Requester {
  if (context.source === "tool") return writeRequesterFromFacts(members, toolWriteFacts(context.tool));
  return resolveRequester(members, context);
}

export function resolveRequester(members: readonly MemberConfig[], context: FeatureInvocationContext): Requester {
  if (context.source === "session-action") {
    const scopes = context.action.client?.scopes;
    return Array.isArray(scopes) ? { from: "page", client: { scopes: [...scopes] } } : { from: "page" };
  }
  if (context.source !== "tool") return { from: "other" };
  const { messageChannel, requesterSenderId, senderIsOwner } = context.tool;
  return requesterFromFacts(members, { channel: messageChannel, senderId: requesterSenderId, senderIsOwner });
}
