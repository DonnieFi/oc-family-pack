import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMessageBatchSendResult } from "openclaw/plugin-sdk/channel-outbound";
import { deliver, type DeliveryDirectory, type DiscordMessage } from "./discord-delivery.ts";

const DIRECTORY: DeliveryDirectory = {
  members: [
    { profileId: "donnie", discordId: "111111111111111111" },
    { profileId: "penny" },
  ],
  channels: { smithy: "222222222222222222" },
};
const CFG = { channels: { discord: { enabled: true } } };
const BRIEF: DiscordMessage[] = [
  { embed: { title: "📅 Today", description: "Dentist at 10:00 AM", color: 0xe67e22, fields: [{ name: "🕐 Time", value: "10:00 AM – 11:00 AM", inline: true }], footer: { text: "React ✅ Going" } } },
  { text: "Swim at 6:00 PM" },
];
const KEY = "brief:2026-10-04";
const receipt = (ids: string[]) => ({ platformMessageIds: ids, parts: ids.map((id, index) => ({ platformMessageId: id, kind: "text" as const, index })), sentAt: 1_790_000_000_000 });
/** The shape the spike saw: the host's OutboundDeliveryError with the Discord plugin's error as its cause. */
const hostError = (cause: unknown) => Object.assign(new Error("send failed", { cause }), { name: "OutboundDeliveryError", stage: "platform_send" });

function fakeSend(result: DurableMessageBatchSendResult) {
  const calls: unknown[] = [];
  const send = async (params: unknown) => {
    calls.push(params);
    return result;
  };
  return { send, calls };
}

test("a brief to a channel key goes out as one keyed batch: the embed rides on channelData.discord, the receipt keeps the message ids", async () => {
  const { send, calls } = fakeSend({ status: "sent", results: [], receipt: receipt(["900000000000000001", "900000000000000002"]) });
  const outcome = await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY);
  assert.deepEqual(outcome, { status: "sent", receipt: { messageIds: ["900000000000000001", "900000000000000002"], sentAt: 1_790_000_000_000 } });
  assert.deepEqual(calls, [
    {
      cfg: CFG,
      channel: "discord",
      to: "channel:222222222222222222",
      payloads: [
        { channelData: { discord: { embeds: [BRIEF[0]!.embed] } } },
        { text: "Swim at 6:00 PM" },
      ],
      deliveryIntentId: "oc-family-pack:delivery:v1:brief:2026-10-04",
      completionRetention: { idPrefix: "oc-family-pack:delivery:v1:", maxAgeMs: 86_400_000, maxEntries: 2_000 },
    },
  ]);
});

test("a member target is that member's DMs; a member without a Discord id, an unknown member or an unknown channel key is no-channel and sends nothing", async () => {
  const { send, calls } = fakeSend({ status: "sent", results: [], receipt: receipt(["900000000000000003"]) });
  assert.equal((await deliver(send, CFG, DIRECTORY, { member: "donnie" }, [{ text: "hi" }], KEY)).status, "sent");
  assert.equal((calls[0] as { to: string }).to, "user:111111111111111111");
  for (const target of [{ member: "penny" }, { member: "calla" }, { channel: "kitchen" }, { channel: "constructor" }]) {
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, target, [{ text: "hi" }], KEY), { status: "failed", errorKind: "no-channel" }, JSON.stringify(target));
  }
  assert.equal(calls.length, 1);
});

test("partial delivery keeps the ids that went out and names the error kind of the one that didn't", async () => {
  const { send } = fakeSend({ status: "partial_failed", results: [], receipt: receipt(["900000000000000004"]), error: hostError({ name: "DiscordError", status: 400, discordCode: 50035 }), sentBeforeError: true });
  assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "partial", receipt: { messageIds: ["900000000000000004"], sentAt: 1_790_000_000_000 }, errorKind: "other" });
});

test("the host's Discord errors split into no-permission, no-channel and other by the wrapped cause", async () => {
  const cases: [unknown, string][] = [
    [hostError({ name: "DiscordSendError", kind: "missing-permissions", discordCode: 50013, status: 403 }), "no-permission"],
    [hostError({ name: "DiscordSendError", kind: "missing-permissions", discordCode: 50013 }), "no-permission"],
    [hostError({ name: "DiscordSendError", kind: "dm-blocked", discordCode: 50007 }), "no-permission"],
    [hostError({ name: "DiscordError", status: 403, discordCode: 50001 }), "no-permission"],
    [hostError({ name: "DiscordError", status: 404, discordCode: 10003 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 404, discordCode: 10013 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 400, discordCode: 50035 }), "other"],
    [hostError({ name: "RateLimitError", status: 429 }), "other"],
    [hostError(new Error("socket hang up")), "other"],
    [Object.assign(new Error("not wrapped"), { status: 403 }), "other"],
    [undefined, "other"],
  ];
  for (const [error, kind] of cases) {
    const { send } = fakeSend({ status: "failed", error, stage: "platform_send" });
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "failed", errorKind: kind }, JSON.stringify((error as { cause?: unknown })?.cause ?? error));
  }
});

test("a key the host already holds comes back claimed, not failed, so the caller never sends it again", async () => {
  for (const message of ["Stable delivery intent is already queued: oc-family-pack:delivery:v1:brief:2026-10-04", "Stable delivery intent is awaiting queue migration: oc-family-pack:delivery:v1:brief:2026-10-04"]) {
    const { send } = fakeSend({ status: "failed", error: new Error(message) });
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "claimed" }, message);
  }
  const { send } = fakeSend({ status: "failed", error: { message: "Stable delivery intent is already queued: x" } });
  assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "failed", errorKind: "other" });
});

test("a batch the host suppressed reached nobody, so it is failed, not sent", async () => {
  const { send } = fakeSend({ status: "suppressed", results: [], receipt: receipt([]), reason: "no_visible_payload" });
  assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "failed", errorKind: "other" });
});
