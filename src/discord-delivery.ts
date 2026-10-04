import type { DurableMessageBatchSendResult, MessageReceipt, sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { MemberConfig } from "./types.ts";

type Send = typeof sendDurableMessageBatch;
type HostConfig = Parameters<Send>[0]["cfg"];

/** Who a delivery goes to: a roster member's DMs, or a configured channel by its key. Never a raw Discord id. */
export type DeliveryTarget = { member: string } | { channel: string };

/** Ids are looked up at send time, so stored targets stay member ids and channel keys. */
export type DeliveryDirectory = {
  members: readonly Pick<MemberConfig, "profileId" | "discordId">[];
  channels: Readonly<Record<string, string>>;
};

/** Bernie's embed (ui/embeds.py): title, description, color, fields, footer. */
export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
};

/** One Discord message of a batch: text, an embed, or both. */
export type DiscordMessage = { text?: string; embed?: DiscordEmbed };

export type ErrorKind = "no-permission" | "no-channel" | "other";

/** What a delivery row keeps: the Discord message ids in send order, and when the host recorded the send. */
export type DeliveryReceipt = { messageIds: string[]; sentAt: number };

/**
 * failed: our own check found no Discord id for the target, so nothing reached the host and the
 * caller may try again. held: the host says nothing went out before it failed to connect, and keeps
 * the batch to deliver later itself. unknown: something may have reached Discord. claimed: the host
 * already holds this key (sent before, in flight, or lost to a crash mid-send). Only failed is retried.
 */
export type DeliveryOutcome =
  | { status: "sent"; receipt: DeliveryReceipt }
  | { status: "partial"; receipt: DeliveryReceipt; errorKind: ErrorKind; detail: string }
  | { status: "failed"; errorKind: "no-channel"; detail: string }
  | { status: "held" | "unknown"; errorKind: ErrorKind; detail: string }
  | { status: "claimed" };

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
export const PRE_CONNECT_CODES: readonly string[] = [
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

function discordTo(directory: DeliveryDirectory, target: DeliveryTarget): string | undefined {
  if ("member" in target) {
    const id = directory.members.find((member) => member.profileId === target.member)?.discordId;
    return id ? `user:${id}` : undefined;
  }
  const id = Object.hasOwn(directory.channels, target.channel) ? directory.channels[target.channel] : undefined;
  return id ? `channel:${id}` : undefined;
}

/** The Discord plugin reads embeds from channelData.discord (openclaw v2026.9.7 extensions/discord/src/outbound-payload.ts:206-243). */
function payloadOf(message: DiscordMessage) {
  return {
    ...(message.text ? { text: message.text } : {}),
    ...(message.embed ? { channelData: { discord: { embeds: [message.embed] } } } : {}),
  };
}

/**
 * The host's OutboundDeliveryError (openclaw v2026.9.7 src/infra/outbound/deliver-types.ts:138-167) carries
 * sentBeforeError and queueCustody, and keeps the Discord plugin's error as its cause: DiscordSendError
 * (extensions/discord/src/send.shared.ts:171-236) or DiscordError (src/internal/rest-errors.ts:197-223), both
 * with status and discordCode, or a fetch TypeError whose own cause has the network code. Read by fields,
 * because the classes live in other modules.
 */
type HostError = {
  sentBeforeError?: unknown;
  queueCustody?: unknown;
  cause?: { status?: unknown; discordCode?: unknown; cause?: { code?: unknown } };
};

function hostError(error: unknown): HostError {
  return typeof error === "object" && error !== null ? (error as HostError) : {};
}

function errorKind(error: HostError): ErrorKind {
  const { status, discordCode } = error.cause ?? {};
  if (NO_PERMISSION_CODES.has(discordCode as number)) return "no-permission";
  if (NO_CHANNEL_CODES.has(discordCode as number)) return "no-channel";
  if (status === 403) return "no-permission";
  if (status === 404) return "no-channel";
  return "other";
}

function networkCode(error: HostError): string | undefined {
  const code = error.cause?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** Field values only: a host message can carry channel ids and URLs. */
function detailOf(error: HostError): string {
  const { status, discordCode } = error.cause ?? {};
  const what =
    typeof status === "number"
      ? `Discord HTTP ${status}${typeof discordCode === "number" ? ` code ${discordCode}` : ""}`
      : networkCode(error) !== undefined
        ? `network ${networkCode(error)}`
        : "host error";
  return `${what}; sentBeforeError ${String(error.sentBeforeError)}; queueCustody ${String(error.queueCustody)}`.slice(0, 200);
}

/** A plain Error from the queue, thrown before any platform send (openclaw v2026.9.7 src/infra/outbound/deliver-queue.ts:353-364). */
function isClaimed(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Stable delivery intent is ");
}

function receiptOf(receipt: MessageReceipt): DeliveryReceipt {
  return { messageIds: [...receipt.platformMessageIds], sentAt: receipt.sentAt };
}

/**
 * held needs the host to say nothing went out (sentBeforeError false), to still hold the batch, and a
 * pre-connect code we recognise. Anything else that failed may have reached Discord: unknown.
 */
function outcomeOf(result: DurableMessageBatchSendResult): DeliveryOutcome {
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
      if (isClaimed(result.error)) return { status: "claimed" };
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
export async function deliver(send: Send, cfg: HostConfig, directory: DeliveryDirectory, target: DeliveryTarget, messages: readonly DiscordMessage[], key: string): Promise<DeliveryOutcome> {
  const to = discordTo(directory, target);
  if (!to) return { status: "failed", errorKind: "no-channel", detail: "no Discord id for this target in config" };
  return outcomeOf(await send({ cfg, channel: "discord", to, payloads: messages.map(payloadOf), deliveryIntentId: KEY_PREFIX + key, completionRetention: KEY_RETENTION }));
}
