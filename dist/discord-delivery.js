/**
 * The host refuses a second send of a key it still holds, as long as the completed entry is kept
 * (openclaw src/infra/outbound/deliver-queue.ts:333-364). Retention matches the host's own cron
 * producer (src/cron/isolated-agent/delivery-dispatch-policy.ts:32-36).
 */
const KEY_PREFIX = "oc-family-pack:delivery:v1:";
const KEY_RETENTION = { idPrefix: KEY_PREFIX, maxAgeMs: 24 * 60 * 60_000, maxEntries: 2_000 };
function discordTo(directory, target) {
    if ("member" in target) {
        const id = directory.members.find((member) => member.profileId === target.member)?.discordId;
        return id ? `user:${id}` : undefined;
    }
    const id = Object.hasOwn(directory.channels, target.channel) ? directory.channels[target.channel] : undefined;
    return id ? `channel:${id}` : undefined;
}
/** The Discord plugin reads embeds from channelData.discord (openclaw extensions/discord/src/outbound-payload.ts:206-245). */
function payloadOf(message) {
    return {
        ...(message.text ? { text: message.text } : {}),
        ...(message.embed ? { channelData: { discord: { embeds: [message.embed] } } } : {}),
    };
}
/**
 * The host wraps the Discord plugin's error in OutboundDeliveryError (openclaw
 * src/infra/outbound/deliver-types.ts:173-202) and keeps it as the cause. The cause comes from another
 * module, so it is read by its fields: DiscordSendError.kind for codes 50013 and 50007
 * (extensions/discord/src/send.shared.ts:165-230), otherwise DiscordError's HTTP status
 * (extensions/discord/src/internal/rest-errors.ts:184-210).
 */
function errorKind(error) {
    const cause = (error ?? {}).cause ?? {};
    if (cause.kind === "missing-permissions" || cause.kind === "dm-blocked" || cause.status === 403)
        return "no-permission";
    if (cause.status === 404)
        return "no-channel";
    return "other";
}
/** A plain Error from the queue, thrown before any platform send (openclaw src/infra/outbound/deliver-queue.ts:353-364). */
function isClaimed(error) {
    return error instanceof Error && error.message.startsWith("Stable delivery intent is ");
}
function receiptOf(receipt) {
    return { messageIds: [...receipt.platformMessageIds], sentAt: receipt.sentAt };
}
function outcomeOf(result) {
    switch (result.status) {
        case "sent":
            return { status: "sent", receipt: receiptOf(result.receipt) };
        case "partial_failed":
            return { status: "partial", receipt: receiptOf(result.receipt), errorKind: errorKind(result.error) };
        case "suppressed":
            return { status: "failed", errorKind: "other" };
        case "failed":
            return isClaimed(result.error) ? { status: "claimed" } : { status: "failed", errorKind: errorKind(result.error) };
    }
}
/**
 * Sends one batch to Discord through the host's durable outbound, with no agent turn in between.
 * `key` names this delivery; a second call with the same key inside a day returns "claimed".
 */
export async function deliver(send, cfg, directory, target, messages, key) {
    const to = discordTo(directory, target);
    if (!to)
        return { status: "failed", errorKind: "no-channel" };
    return outcomeOf(await send({ cfg, channel: "discord", to, payloads: messages.map(payloadOf), deliveryIntentId: KEY_PREFIX + key, completionRetention: KEY_RETENTION }));
}
