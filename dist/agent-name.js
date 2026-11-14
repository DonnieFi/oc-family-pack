/** The host's error code when a Gateway has several agents and no unique default. */
const SELECTION_REQUIRED = "AGENT_SELECTION_REQUIRED";
function isSelectionRequired(error) {
    return typeof error === "object" && error !== null && error.code === SELECTION_REQUIRED;
}
/** Resolve the agent a brief footer names.
 *
 * `resolveDefaultAgentId` throws `AgentSelectionRequiredError` when several
 * agents are configured and none owns ambient work. A brief is ambient, so
 * fall back to `main` when the fleet has it, else to a configured agent, rather
 * than failing the whole brief. Any other error is a real fault and is
 * rethrown, so a host problem still reaches the log. */
export function resolveBriefAgentName(config, resolveDefaultAgentId, resolveAgentIdentity, listAgentIds) {
    let agentId;
    try {
        agentId = resolveDefaultAgentId(config);
    }
    catch (error) {
        if (!isSelectionRequired(error))
            throw error;
        const ids = listAgentIds(config);
        agentId = ids.includes("main") ? "main" : (ids[0] ?? "main");
    }
    return resolveAgentIdentity(config, agentId)?.name?.trim() || agentId;
}
