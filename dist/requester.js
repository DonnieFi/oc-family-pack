export function resolveRequester(members, context) {
    if (context.source === "session-action") {
        const scopes = context.action.client?.scopes;
        return Array.isArray(scopes) ? { from: "page", client: { scopes: [...scopes] } } : { from: "page" };
    }
    if (context.source !== "tool")
        return { from: "other" };
    const { messageChannel, requesterSenderId, senderIsOwner } = context.tool;
    if (messageChannel === "discord") {
        const member = requesterSenderId === undefined ? undefined : members.find((entry) => entry.discordId === requesterSenderId);
        return member ? { from: "discord", member } : { from: "discord" };
    }
    return { from: "tool", senderIsOwner: senderIsOwner === true };
}
