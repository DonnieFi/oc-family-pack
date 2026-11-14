import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
function isSelectionRequired(error) {
    return typeof error === "object" && error !== null && error.code === "AGENT_SELECTION_REQUIRED";
}
/** Attribution follows the same explicit Discord account as brief delivery. */
export function briefSenderAgentId(config, host) {
    try {
        if (config.discordAccount === undefined)
            return resolveDefaultAgentId(host);
        return resolveAgentRoute({ cfg: host, channel: "discord", accountId: config.discordAccount }).agentId;
    }
    catch (error) {
        if (!isSelectionRequired(error))
            throw error;
        const ids = listAgentIds(host);
        return ids.includes("main") ? "main" : (ids[0] ?? "main");
    }
}
