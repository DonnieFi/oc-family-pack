import { Type } from "typebox";
import { DEMO_MEMBERS } from "./demo.js";
export const FAMILY_CONTACT_TOOL = "family_contact";
export const FamilyContactSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 200, description: "The family member's id." }),
}, { additionalProperties: false });
const OPERATOR_ONLY = "Only the operator can look up a contact.";
const NEED_ID = "Say which person, by their id.";
const UNKNOWN = "That person is not in the family.";
/**
 * Operator authority for a contact lookup. `senderIsOwner` is the host's owner
 * bit. `conversationReadOrigin` is accepted so a caller can pass the tool
 * context, and it is ignored: the host documents it as conversation-read
 * visibility, not an authorization grant.
 */
export function contactAuthority(facts) {
    return facts.senderIsOwner === true;
}
function roster(config) {
    return config.demo ? DEMO_MEMBERS : config.members;
}
/** One member, for the model. Email is included only here, and only for the operator. */
export function contactCard(member) {
    const card = { id: member.id, name: member.displayName };
    if (member.email !== undefined)
        card.email = member.email;
    if (member.phone !== undefined)
        card.phone = member.phone;
    if (member.discordId !== undefined)
        card.discordId = member.discordId;
    if (member.devices.length > 0)
        card.devices = member.devices.map((device) => ({ id: device.id, label: device.label }));
    return card;
}
function text(value, ok) {
    return { content: [{ type: "text", text: value }], details: { status: ok ? "ok" : "refused" } };
}
/**
 * The operator's one-person contact lookup. Everyone else is refused before
 * the roster is read, so a refusal never says whether the id exists.
 * The result text is for the model. Nothing here is logged.
 */
export function familyContact(config, facts = {}) {
    const operator = contactAuthority(facts);
    return {
        name: FAMILY_CONTACT_TOOL,
        label: "Contact",
        description: "Look up one family member by id. Only the operator may use this. Returns that person's id and name, plus email, phone, Discord id, and device labels when they are set. Email and phone are contact details, not delivery routes. Device addresses and MAC addresses are not included. It does not list the family. Discord can name a person in chat by discordId. Other chats are not a person unless the host marks the caller as the operator.",
        parameters: FamilyContactSchema,
        execute: async (_toolCallId, params) => {
            if (!operator)
                return text(OPERATOR_ONLY, false);
            const raw = typeof params?.id === "string" ? params.id.trim().toLowerCase() : "";
            if (raw === "")
                return text(NEED_ID, false);
            const member = roster(config).find((item) => item.id === raw);
            if (member === undefined)
                return text(UNKNOWN, false);
            return text(JSON.stringify(contactCard(member)), true);
        },
    };
}
