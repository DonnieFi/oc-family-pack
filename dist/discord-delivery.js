/**
 * The host refuses a second send of a key it still holds, as long as the completed entry is kept
 * (openclaw v2026.9.7 src/infra/outbound/deliver-queue.ts:333-364). Retention matches the host's own
 * cron producer (src/cron/isolated-agent/delivery-dispatch-policy.ts:32-36).
 */
const KEY_PREFIX = "oc-family-pack:delivery:v1:";
const KEY_RETENTION = { idPrefix: KEY_PREFIX, maxAgeMs: 24 * 60 * 60_000, maxEntries: 2_000 };
/**
 * Failures the host proves happened before a connection (openclaw v2026.9.7
 * src/infra/delivery-recovery.shared.ts:22-29 and :104-114). They arrive as the cause of the Discord
 * plugin's fetch error, so the code is read at error.cause.cause.code and nowhere else.
 */
export const PRE_CONNECT_CODES = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
];
const NO_PERMISSION_CODES = new Set([50001, 50007, 50013]);
const NO_CHANNEL_CODES = new Set([10003, 10013]);
function discordTo(directory, target) {
    if ("member" in target) {
        const id = directory.members.find((member) => member.profileId === target.member)?.discordId;
        return id ? `user:${id}` : undefined;
    }
    const id = Object.hasOwn(directory.channels, target.channel) ? directory.channels[target.channel] : undefined;
    return id ? `channel:${id}` : undefined;
}
/** The Discord plugin reads embeds from channelData.discord (openclaw v2026.9.7 extensions/discord/src/outbound-payload.ts:206-243). */
function payloadOf(message) {
    return {
        ...(message.text ? { text: message.text } : {}),
        ...(message.embed ? { channelData: { discord: { embeds: [message.embed] } } } : {}),
    };
}
function hostError(error) {
    return typeof error === "object" && error !== null ? error : {};
}
function errorKind(error) {
    const { status, discordCode } = error.cause ?? {};
    if (NO_PERMISSION_CODES.has(discordCode))
        return "no-permission";
    if (NO_CHANNEL_CODES.has(discordCode))
        return "no-channel";
    if (status === 403)
        return "no-permission";
    if (status === 404)
        return "no-channel";
    return "other";
}
function networkCode(error) {
    const code = error.cause?.cause?.code;
    return typeof code === "string" ? code : undefined;
}
/** Field values only: a host message can carry channel ids and URLs. */
function detailOf(error) {
    const { status, discordCode } = error.cause ?? {};
    const what = typeof status === "number"
        ? `Discord HTTP ${status}${typeof discordCode === "number" ? ` code ${discordCode}` : ""}`
        : networkCode(error) !== undefined
            ? `network ${networkCode(error)}`
            : "host error";
    return `${what}; sentBeforeError ${String(error.sentBeforeError)}; queueCustody ${String(error.queueCustody)}`.slice(0, 200);
}
/** A plain Error from the queue, thrown before any platform send (openclaw v2026.9.7 src/infra/outbound/deliver-queue.ts:353-364). */
function isClaimed(error) {
    return error instanceof Error && error.message.startsWith("Stable delivery intent is ");
}
function receiptOf(receipt) {
    return { messageIds: [...receipt.platformMessageIds], sentAt: receipt.sentAt };
}
/**
 * held needs the host to say nothing went out (sentBeforeError false), to still hold the batch, and a
 * pre-connect code we recognise. Anything else that failed may have reached Discord: unknown.
 */
function outcomeOf(result) {
    switch (result.status) {
        case "sent":
            return { status: "sent", receipt: receiptOf(result.receipt) };
        case "partial_failed": {
            const error = hostError(result.error);
            return { status: "partial", receipt: receiptOf(result.receipt), errorKind: errorKind(error), detail: detailOf(error) };
        }
        case "suppressed":
            return { status: "unknown", errorKind: "other", detail: `host suppressed the batch: ${String(result.reason)}`.slice(0, 200) };
        case "failed": {
            if (isClaimed(result.error))
                return { status: "claimed" };
            const error = hostError(result.error);
            const code = networkCode(error);
            const held = error.sentBeforeError === false && error.queueCustody === "held" && code !== undefined && PRE_CONNECT_CODES.includes(code);
            return { status: held ? "held" : "unknown", errorKind: errorKind(error), detail: detailOf(error) };
        }
    }
}
/**
 * Sends one batch to Discord through the host's durable outbound, with no agent turn in between.
 * `key` is the delivery intent, used as is: a second call with the same key inside a day returns "claimed".
 */
export async function deliver(send, cfg, directory, target, messages, key) {
    const to = discordTo(directory, target);
    if (!to)
        return { status: "failed", errorKind: "no-channel", detail: "no Discord id for this target in config" };
    return outcomeOf(await send({ cfg, channel: "discord", to, payloads: messages.map(payloadOf), deliveryIntentId: KEY_PREFIX + key, completionRetention: KEY_RETENTION }));
}
