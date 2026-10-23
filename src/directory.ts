// The roster is the contact directory. These helpers materialize the ids the
// plugin already uses and apply an edit through parseConfig. They print a
// config patch. They do not write the Gateway config.

import { ConfigError, MemberError, parseConfig, readMemberIdentity } from "./config.ts";
import { DIRECTORY_PERSISTENCE } from "./directory-contract.ts";
import type { MemberConfig, MemberRole, ReminderMode } from "./types.ts";

export type DirectoryEdit = {
  id: string;
  displayName?: string;
  /** `null` clears the login. A string replaces it and does not change `id`. */
  login?: string | null;
  gatewayProfileId?: string | null;
  email?: string | null;
  phone?: string | null;
  discordId?: string | null;
  devices?: unknown[];
};

export type DirectoryDevice = {
  id: string;
  label: string;
  hostname?: string;
  primaryMac: string;
  aliasMacs: string[];
  source: string;
  reservation?: { address: string; network?: string; source: string };
  sharedWith: string[];
};

export type DirectoryMember = {
  id: string;
  displayName: string;
  role: MemberRole;
  login?: string;
  gatewayProfileId?: string;
  email?: string;
  phone?: string;
  discordId?: string;
  reminders: ReminderMode;
  devices: DirectoryDevice[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addToken(tokens: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim() !== "") tokens.add(value.trim().toLowerCase());
}

/** Every string setup or an edit may mean: id, login, and the name. One person can contribute several. */
export function memberReferenceTokens(member: unknown): string[] {
  if (!isRecord(member)) return [];
  const tokens = new Set<string>();
  addToken(tokens, member.id);
  addToken(tokens, member.profileId);
  addToken(tokens, member.login);
  addToken(tokens, member.name);
  addToken(tokens, member.displayName);
  try {
    const identity = readMemberIdentity(member, "members");
    tokens.add(identity.id);
    if (identity.login !== undefined) tokens.add(identity.login);
  } catch {
    // A member that cannot be parsed contributes only the raw strings above.
  }
  return [...tokens];
}

export function matchMemberIndexes(members: readonly unknown[], token: string): number[] {
  const key = token.trim().toLowerCase();
  if (key === "") return [];
  return members.flatMap((member, index) => (memberReferenceTokens(member).includes(key) ? [index] : []));
}

export const AMBIGUOUS_REFERENCE = (token: string) => `\`${token}\` matches more than one person. Use a member id that belongs to only one of them.`;

/** Write the id the plugin already uses onto any member or device that omitted one. */
export function materializeMembers(members: readonly unknown[]): { members: unknown[]; changed: boolean } {
  const effective = parseConfig({ members }).members;
  let changed = false;
  const next = members.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const copy: Record<string, unknown> = { ...entry };
    if (typeof copy.id !== "string" || copy.id.trim() === "") {
      copy.id = readMemberIdentity(copy, `members[${index}]`).id;
      changed = true;
    }
    if (Array.isArray(copy.devices)) {
      copy.devices = copy.devices.map((device, deviceIndex) => {
        if (!isRecord(device)) return device;
        if (typeof device.id === "string" && device.id.trim() !== "") return device;
        const id = effective[index]?.devices[deviceIndex]?.id;
        if (id === undefined) return device;
        changed = true;
        const rest = { ...device };
        delete rest.id;
        return { id, ...rest };
      });
    }
    return copy;
  });
  return { members: next, changed };
}

function membersPatch(members: unknown[]): string {
  return JSON.stringify({ plugins: { entries: { "oc-family-pack": { config: { members } } } } }, null, 2);
}

export function planMaterialize(
  rawMembers: readonly unknown[],
  calendars: readonly unknown[] = [],
): { ok: true; changed: boolean; members: unknown[]; patch: string } | { ok: false; error: string } {
  try {
    const materialized = materializeMembers(rawMembers);
    parseConfig({ members: materialized.members, calendars });
    return { ok: true, changed: materialized.changed, members: materialized.members, patch: materialized.changed ? membersPatch(materialized.members) : "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function applyOptional(target: Record<string, unknown>, key: string, value: string | null): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

/**
 * Apply roster edits to the stored members. An omitted id is written as the
 * current effective id before a login change, so the id does not follow the login.
 * The result is accepted only when parseConfig accepts it, including calendar owners.
 */
export function planDirectoryEdit(
  rawMembers: readonly unknown[],
  edits: readonly DirectoryEdit[],
  calendars: readonly unknown[] = [],
): { ok: true; changed: boolean; members: unknown[]; patch: string } | { ok: false; error: string } {
  const working = rawMembers.map((entry) => entry);
  let changed = false;
  for (const edit of edits) {
    const hits = matchMemberIndexes(working, edit.id);
    if (hits.length !== 1) {
      return { ok: false, error: hits.length === 0 ? "That person is not in the family." : AMBIGUOUS_REFERENCE(edit.id.trim().toLowerCase()) };
    }
    const current = working[hits[0]!];
    if (!isRecord(current)) return { ok: false, error: "That person is not in the family." };
    const next: Record<string, unknown> = { ...current };
    try {
      if (typeof next.id !== "string" || next.id.trim() === "") next.id = readMemberIdentity(next, "members").id;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (edit.displayName !== undefined) {
      if ("name" in next || !("displayName" in next)) next.name = edit.displayName;
      if ("displayName" in next) next.displayName = edit.displayName;
    }
    if (edit.login !== undefined) {
      if (edit.login === null) {
        delete next.login;
        delete next.profileId;
      } else if ("login" in next && !("profileId" in next)) {
        next.login = edit.login;
      } else {
        next.profileId = edit.login;
        if ("login" in next) next.login = edit.login;
      }
    }
    if (edit.gatewayProfileId !== undefined) applyOptional(next, "gatewayProfileId", edit.gatewayProfileId);
    if (edit.email !== undefined) applyOptional(next, "email", edit.email);
    if (edit.phone !== undefined) applyOptional(next, "phone", edit.phone);
    if (edit.discordId !== undefined) applyOptional(next, "discordId", edit.discordId);
    if (edit.devices !== undefined) next.devices = edit.devices;
    if (JSON.stringify(next) !== JSON.stringify(current)) changed = true;
    working[hits[0]!] = next;
  }
  try {
    parseConfig({ members: working, calendars });
  } catch (error) {
    const message = error instanceof MemberError || error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  return { ok: true, changed, members: working, patch: changed ? membersPatch(working) : "" };
}

export function directoryMembers(members: readonly MemberConfig[]): DirectoryMember[] {
  return members.map((member) => ({
    id: member.id,
    displayName: member.displayName,
    role: member.role,
    ...(member.profileId !== undefined ? { login: member.profileId } : {}),
    ...(member.gatewayProfileId !== undefined ? { gatewayProfileId: member.gatewayProfileId } : {}),
    ...(member.email !== undefined ? { email: member.email } : {}),
    ...(member.phone !== undefined ? { phone: member.phone } : {}),
    ...(member.discordId !== undefined ? { discordId: member.discordId } : {}),
    reminders: member.reminders ?? "dm",
    devices: member.devices.map((device) => ({
      id: device.id,
      label: device.label,
      ...(device.hostname !== undefined ? { hostname: device.hostname } : {}),
      primaryMac: device.primaryMac,
      aliasMacs: device.aliasMacs,
      source: device.source,
      ...(device.reservation !== undefined ? { reservation: device.reservation } : {}),
      sharedWith: device.sharedWith,
    })),
  }));
}

export const MATERIALIZE_INTRO =
  "This writes the ids the plugin already uses for these people and devices. Calendar owners and reminder history keep those same ids. After you apply it, changing a name or a login does not change a member id.";

export { DIRECTORY_PERSISTENCE };
