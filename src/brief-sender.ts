import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { Config } from "./types.ts";

type HostConfig = Parameters<typeof resolveAgentRoute>[0]["cfg"];

function isSelectionRequired(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "AGENT_SELECTION_REQUIRED";
}

/** Attribution follows the explicit household agent or the same Discord account as brief delivery. */
export function briefSenderAgentId(config: Pick<Config, "discordAccount" | "agentId">, host: HostConfig): string {
  if (typeof config.agentId === "string" && config.agentId.trim() !== "") return config.agentId.trim();
  try {
    if (config.discordAccount === undefined) return resolveDefaultAgentId(host);
    return resolveAgentRoute({ cfg: host, channel: "discord", accountId: config.discordAccount }).agentId;
  } catch (error) {
    if (!isSelectionRequired(error)) throw error;
    const ids = listAgentIds(host);
    return ids.includes("main") ? "main" : (ids[0] ?? "main");
  }
}
