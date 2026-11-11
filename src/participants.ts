import type { MemberConfig, ParticipantOverride } from "./types.ts";

/**
 * Household sharing policy.
 *
 * A calendar owner stays the owner. A title, or an explicit attendee, may name
 * another household member as a participant. That does not copy the provider
 * event, invite them, or show any other event from a calendar they cannot see.
 * The description is not read. Names are the display name, its first word, and
 * aliases. Member ids, logins, and Discord ids are not names. A word that
 * belongs to two people names nobody until a stored confirm picks one of them.
 * A stored reject removes a title or attendee match.
 */
export type AttendeeName = { email?: string; name?: string };

type NamedEvent = {
  title: string;
  calendarKey: string;
  id: string;
  google?: { eventId?: string; attendees?: readonly AttendeeName[] };
};

/** Display name, its first word, and aliases. Short or blank tokens are skipped. */
export function nameTokens(member: MemberConfig): string[] {
  const tokens = new Set<string>();
  const add = (value: string | undefined) => {
    const key = value?.trim().toLowerCase();
    if (key !== undefined && key.length >= 2) tokens.add(key);
  };
  add(member.displayName);
  add(member.displayName.trim().split(/\s+/)[0]);
  for (const alias of member.aliases ?? []) add(alias);
  return [...tokens];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `token` is a whole Unicode word in `title`. */
export function hasName(title: string, token: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "iu").test(title);
}

/** The provider event id: Google's id when the read kept it, otherwise the wire id's tail. */
export function sourceEventId(event: { id: string; calendarKey: string; google?: { eventId?: string } }): string {
  const fromGoogle = event.google?.eventId?.trim();
  if (fromGoogle) return fromGoogle;
  const prefix = `${event.calendarKey}/`;
  return event.id.startsWith(prefix) ? event.id.slice(prefix.length) : event.id;
}

/**
 * Participants of one event. Ambiguous words are listed and name nobody.
 * Overrides apply only to this calendar and provider event id.
 */
export function eventParticipants(
  event: NamedEvent,
  members: readonly MemberConfig[],
  overrides: readonly ParticipantOverride[] = [],
): { ids: string[]; ambiguous: string[] } {
  const tokenOwners = new Map<string, string[]>();
  for (const member of members) {
    if (member.role === "guest") continue;
    for (const token of nameTokens(member)) {
      const list = tokenOwners.get(token) ?? [];
      if (!list.includes(member.id)) list.push(member.id);
      tokenOwners.set(token, list);
    }
  }
  const ids = new Set<string>();
  const ambiguous = new Set<string>();
  const consider = (token: string) => {
    const owners = tokenOwners.get(token);
    if (owners === undefined || owners.length === 0) return;
    if (owners.length > 1) {
      ambiguous.add(token);
      return;
    }
    ids.add(owners[0]!);
  };
  for (const token of [...tokenOwners.keys()].sort((left, right) => right.length - left.length)) {
    if (hasName(event.title, token)) consider(token);
  }
  for (const attendee of event.google?.attendees ?? []) {
    const email = attendee.email?.trim().toLowerCase();
    if (email) {
      const matched = members.filter((member) => member.email === email && member.role !== "guest");
      if (matched.length === 1) ids.add(matched[0]!.id);
      else if (matched.length > 1) ambiguous.add(email);
    }
    const name = attendee.name?.trim().toLowerCase();
    if (name) consider(name);
  }
  const eventId = sourceEventId(event);
  for (const override of overrides) {
    if (override.calendarKey !== event.calendarKey || override.eventId !== eventId) continue;
    if (override.decision === "reject") ids.delete(override.memberId);
    else if (members.some((member) => member.id === override.memberId && member.role !== "guest")) ids.add(override.memberId);
  }
  return {
    ids: members.map((member) => member.id).filter((id) => ids.has(id)),
    ambiguous: [...ambiguous],
  };
}

/** Participant ids across copies, in roster order, excluding people who already own a projected calendar. */
export function extraParticipantIds(
  copies: readonly NamedEvent[],
  ownerIds: readonly string[],
  members: readonly MemberConfig[],
  overrides: readonly ParticipantOverride[] | undefined,
): string[] {
  const ids = new Set<string>();
  for (const copy of copies) {
    for (const id of eventParticipants(copy, members, overrides ?? []).ids) ids.add(id);
  }
  const owners = new Set(ownerIds);
  return members.map((member) => member.id).filter((id) => ids.has(id) && !owners.has(id));
}
