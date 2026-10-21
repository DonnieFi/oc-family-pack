import { Type } from "typebox";
import { DEMO_MEMBERS } from "./demo.ts";
import type { Config, MemberConfig } from "./types.ts";

export const FAMILY_CONTACT_TOOL = "family_contact";

export const FamilyContactSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200, description: "The family member's id." }),
  },
  { additionalProperties: false },
);

const OPERATOR_ONLY = "Only the operator can look up a contact.";
const NEED_ID = "Say which person, by their id.";
const UNKNOWN = "That person is not in the family.";

export type ContactFacts = { senderIsOwner?: boolean | undefined; directOperator?: boolean | undefined };

export type ContactCard = { id: string; name: string; email?: string; discordId?: string };

function roster(config: Config): readonly MemberConfig[] {
  return config.demo ? DEMO_MEMBERS : config.members;
}

/** One member, for the model. Email is included only here, and only for the operator. */
export function contactCard(member: MemberConfig): ContactCard {
  const card: ContactCard = { id: member.id, name: member.displayName };
  if (member.email !== undefined) card.email = member.email;
  if (member.discordId !== undefined) card.discordId = member.discordId;
  return card;
}

function text(value: string, ok: boolean) {
  return { content: [{ type: "text" as const, text: value }], details: { status: ok ? "ok" : "refused" } };
}

/**
 * The operator's one-person contact lookup. Everyone else is refused before
 * the roster is read, so a refusal never says whether the id exists.
 * The result text is for the model. Nothing here is logged.
 */
export function familyContact(config: Config, facts: ContactFacts = {}) {
  const operator = facts.senderIsOwner === true || facts.directOperator === true;
  return {
    name: FAMILY_CONTACT_TOOL,
    label: "Contact",
    description: "Look up one family member by id. Only the operator may use this. Returns that person's id and name, plus email and Discord id when they are set. It does not list the family.",
    parameters: FamilyContactSchema,
    execute: async (_toolCallId: string, params: unknown) => {
      if (!operator) return text(OPERATOR_ONLY, false);
      const raw = typeof (params as { id?: unknown } | null)?.id === "string" ? (params as { id: string }).id.trim().toLowerCase() : "";
      if (raw === "") return text(NEED_ID, false);
      const member = roster(config).find((item) => item.id === raw);
      if (member === undefined) return text(UNKNOWN, false);
      return text(JSON.stringify(contactCard(member)), true);
    },
  };
}
