/** Resolve the brief footer agent, falling back to the configured main agent
 * when the Gateway has multiple agents and no unique default. */
export function resolveBriefAgentName<T>(
  config: T,
  resolveDefaultAgentId: (config: T) => string,
  resolveAgentIdentity: (config: T, agentId: string) => { name?: string | undefined } | undefined,
): string {
  let agentId: string;
  try {
    agentId = resolveDefaultAgentId(config);
  } catch {
    agentId = "main";
  }
  return resolveAgentIdentity(config, agentId)?.name?.trim() || agentId;
}
