import type { MemberConfig } from "./types.ts";

/**
 * The strings that address one person. The id, login, display name, first name,
 * optional aliases and the Discord id are addressing keys only: none of these
 * grants a page identity, a Discord identity, or a calendar permission.
 */
export function memberReferenceTokens(member: MemberConfig): string[] {
  const tokens = new Set<string>();
  const add = (value: string | undefined) => {
    const key = value?.trim().toLowerCase();
    if (key !== undefined && key !== "") tokens.add(key);
  };
  add(member.id);
  add(member.profileId);
  add(member.displayName);
  add(member.displayName.trim().split(/\s+/)[0]);
  add(member.discordId);
  for (const alias of member.aliases ?? []) add(alias);
  return [...tokens];
}

export type MemberReference =
  | { member: MemberConfig }
  | { error: string };

/**
 * Resolve a person the way the family speaks: id, login, display name, first
 * name, alias, or Discord id. Unknown and ambiguous references fail closed.
 * Callers must still apply read visibility before returning any calendar data.
 */
export function resolveMemberReference(members: readonly MemberConfig[], token: string): MemberReference {
  const key = token.trim().toLowerCase();
  if (key === "") return { error: "That person is not in the family." };
  // A member id or login is authoritative even when another person's first
  // name is the same string. Names and aliases only decide when no key does.
  const exact = members.filter((member) => member.id === key || member.profileId === key);
  if (exact.length === 1) return { member: exact[0]! };
  if (exact.length > 1) return { error: `"${token.trim()}" matches more than one person. Use their member id.` };
  const hits = members.filter((member) => memberReferenceTokens(member).includes(key));
  if (hits.length === 1) return { member: hits[0]! };
  if (hits.length > 1) return { error: `"${token.trim()}" matches more than one person. Use their member id.` };
  return { error: "That person is not in the family." };
}
