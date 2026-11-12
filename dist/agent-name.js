/** Resolve the brief footer agent, falling back to the configured main agent
 * when the Gateway has multiple agents and no unique default. */
export function resolveBriefAgentName(config, resolveDefaultAgentId, resolveAgentIdentity) {
    let agentId;
    try {
        agentId = resolveDefaultAgentId(config);
    }
    catch {
        agentId = "main";
    }
    return resolveAgentIdentity(config, agentId)?.name?.trim() || agentId;
}
