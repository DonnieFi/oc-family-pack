import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeAgentId, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { Config } from "./types.ts";

type HostConfig = Parameters<typeof resolveAgentRoute>[0]["cfg"];

const NO_AGENTS = "No agents configured. Run `openclaw onboard` or `openclaw agents add` first.";

function isSelectionRequired(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "AGENT_SELECTION_REQUIRED";
}

/** The ambient owner a template install records, for example Hopper's `agent.id`. */
function systemAgentId(host: HostConfig): string | undefined {
  const agents = host.agents as { defaults?: { systemAgent?: { agentId?: unknown } } } | undefined;
  const raw = agents?.defaults?.systemAgent?.agentId;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return normalizeAgentId(raw);
}

function unknownAgent(id: string, ids: readonly string[]): Error {
  const listed = ids.length > 0 ? ids.join(", ") : "none";
  return new Error(`\`agentId\` is set to \`${id}\`, which is not one of the configured agents (${listed}). Set plugins.entries.oc-family-pack.config.agentId to one of them.`);
}

/**
 * Household agent for briefs, reminders, and kid or guest chat.
 * An explicit plugin `agentId` wins. A Discord account uses that account's route.
 * Otherwise this follows the host: `agents.defaults.systemAgent.agentId` (the owner
 * template and team installs record), then the legacy default, then the sole agent.
 * An empty fleet throws. An ownerless multi-agent fleet still prefers `main`, then
 * the first configured id, so a brief does not crash.
 */
export function briefSenderAgentId(config: Pick<Config, "discordAccount" | "agentId">, host: HostConfig): string {
  const ids = listAgentIds(host);
  if (typeof config.agentId === "string" && config.agentId.trim() !== "") {
    const id = normalizeAgentId(config.agentId);
    if (!ids.includes(id)) throw unknownAgent(id, ids);
    return id;
  }
  const system = systemAgentId(host);
  if (config.discordAccount === undefined && system !== undefined && ids.includes(system)) return system;
  try {
    if (config.discordAccount === undefined) return resolveDefaultAgentId(host);
    return resolveAgentRoute({ cfg: host, channel: "discord", accountId: config.discordAccount }).agentId;
  } catch (error) {
    if (!isSelectionRequired(error)) throw error;
    if (system !== undefined && ids.includes(system)) return system;
    if (ids.length === 0) throw new Error(NO_AGENTS);
    return ids.includes("main") ? "main" : ids[0]!;
  }
}
