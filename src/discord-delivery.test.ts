import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableMessageBatchSendResult } from "openclaw/plugin-sdk/channel-outbound";
import { deliver, PRE_CONNECT_CODES, type DeliveryDirectory, type DiscordMessage } from "./discord-delivery.ts";

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
const KEY = "daily-summary:2026-10-04";
const receipt = (ids: string[]) => ({ platformMessageIds: ids, parts: ids.map((id, index) => ({ platformMessageId: id, kind: "text" as const, index })), sentAt: 1_790_000_000_000 });
/** The shape the spike and the s5k.8 drop probe saw: the host's OutboundDeliveryError, the Discord plugin's error as its cause. */
const hostError = (cause: unknown, sentBeforeError = true, queueCustody = "held") =>
  Object.assign(new Error("send failed", { cause }), { name: "OutboundDeliveryError", stage: "platform_send", sentBeforeError, queueCustody });
/** A fetch that never connected: undici's TypeError with the socket error as its cause (s5k.8-dropped-c074824.log case 3a). */
const network = (code: string, syscall = "connect") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code, syscall }) });

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
      deliveryIntentId: "oc-family-pack:delivery:v1:daily-summary:2026-10-04",
      completionRetention: { idPrefix: "oc-family-pack:delivery:v1:", maxAgeMs: 86_400_000, maxEntries: 2_000 },
    },
  ]);
});

test("a member target is that member's DMs; a member without a Discord id, an unknown member or an unknown channel key is no-channel and sends nothing", async () => {
  const { send, calls } = fakeSend({ status: "sent", results: [], receipt: receipt(["900000000000000003"]) });
  assert.equal((await deliver(send, CFG, DIRECTORY, { member: "donnie" }, [{ text: "hi" }], KEY)).status, "sent");
  assert.equal((calls[0] as { to: string }).to, "user:111111111111111111");
  for (const target of [{ member: "penny" }, { member: "calla" }, { channel: "kitchen" }, { channel: "constructor" }]) {
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, target, [{ text: "hi" }], KEY), { status: "failed", errorKind: "no-channel", detail: "no Discord id for this target in config" }, JSON.stringify(target));
  }
  assert.equal(calls.length, 1);
});

test("partial delivery keeps every id that went out and names the error kind of the one that didn't", async () => {
  const { send } = fakeSend({ status: "partial_failed", results: [], receipt: receipt(["900000000000000004", "900000000000000005"]), error: hostError({ name: "DiscordSendError", status: 403, discordCode: 50013 }), sentBeforeError: true });
  const three = [...BRIEF, { text: "Bring the permission slip" }];
  assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, three, KEY), {
    status: "partial",
    receipt: { messageIds: ["900000000000000004", "900000000000000005"], sentAt: 1_790_000_000_000 },
    errorKind: "no-permission",
    detail: "Discord HTTP 403 code 50013; sentBeforeError true; queueCustody held",
  });
});

test("a Discord answer after the request went out is unknown, never retried; its code or status only picks the error kind", async () => {
  const cases: [unknown, string][] = [
    [hostError({ name: "DiscordSendError", kind: "missing-permissions", discordCode: 50013, status: 403 }), "no-permission"],
    [hostError({ name: "DiscordSendError", kind: "missing-permissions", discordCode: 50013 }), "no-permission"],
    [hostError({ name: "DiscordSendError", kind: "dm-blocked", discordCode: 50007 }), "no-permission"],
    [hostError({ name: "DiscordError", status: 403, discordCode: 50001 }), "no-permission"],
    [hostError({ name: "DiscordError", status: 403 }), "no-permission"],
    [hostError({ name: "DiscordError", status: 404, discordCode: 10003 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 404, discordCode: 10013 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 400, discordCode: 10013 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 404 }), "no-channel"],
    [hostError({ name: "DiscordError", status: 400, discordCode: 50035 }), "other"],
    [hostError({ name: "RateLimitError", status: 429 }), "other"],
    [hostError({ name: "DiscordError", status: 502 }), "other"],
    [hostError(new Error("socket hang up")), "other"],
    [Object.assign(new Error("not wrapped"), { status: 403 }), "other"],
    [undefined, "other"],
  ];
  for (const [error, kind] of cases) {
    const { send } = fakeSend({ status: "failed", error, stage: "platform_send" });
    const outcome = await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY);
    assert.deepEqual([outcome.status, "errorKind" in outcome && outcome.errorKind], ["unknown", kind], JSON.stringify((error as { cause?: unknown })?.cause ?? error));
  }
});

// One test per Discord code: the code alone picks the kind, whatever the status says.
for (const [code, kind] of [[50001, "no-permission"], [50007, "no-permission"], [50013, "no-permission"], [10003, "no-channel"], [10013, "no-channel"]] as const) {
  test(`Discord code ${code} is ${kind}`, async () => {
    const { send } = fakeSend({ status: "failed", error: hostError({ name: "DiscordError", status: 400, discordCode: code }), stage: "platform_send" });
    const outcome = await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY);
    assert.deepEqual([outcome.status, "errorKind" in outcome && outcome.errorKind], ["unknown", kind]);
  });
}

// One test per pre-connect code (arch amend 2): the code at error.cause.cause.code, never the message text.
const PRE_CONNECT = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_DNS_RESOLVE_FAILED"];
test("the pre-connect codes are exactly these", () => {
  assert.deepEqual([...PRE_CONNECT_CODES], PRE_CONNECT);
});
for (const code of PRE_CONNECT) {
  test(`${code} before connecting, with the host still holding the batch, is held`, async () => {
    const { send } = fakeSend({ status: "failed", error: hostError(network(code), false), stage: "platform_send" });
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), {
      status: "held",
      errorKind: "other",
      detail: `network ${code}; sentBeforeError false; queueCustody held`,
    });
  });
}

test("a network failure is held only when the code is known, the host says nothing went out, and the host still holds it", async () => {
  const cases: [unknown, string][] = [
    [hostError(network("ECONNRESET"), false), "unknown code"],
    [hostError(network("ETIMEDOUT"), false), "timeout after connect"],
    [hostError(Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") }), false), "code only in the message text"],
    [hostError(network("ECONNREFUSED"), true), "the host says something went out"],
    [hostError(network("ECONNREFUSED"), false, "released"), "the host let go of it"],
    [Object.assign(hostError(network("ECONNREFUSED")), { sentBeforeError: undefined }), "no sentBeforeError"],
  ];
  for (const [error, why] of cases) {
    const { send } = fakeSend({ status: "failed", error, stage: "platform_send" });
    assert.equal((await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY)).status, "unknown", why);
  }
});

test("a key the host already holds comes back claimed, not failed, so the caller never sends it again", async () => {
  for (const message of ["Stable delivery intent is already queued: oc-family-pack:delivery:v1:brief:2026-10-04", "Stable delivery intent is awaiting queue migration: oc-family-pack:delivery:v1:brief:2026-10-04"]) {
    const { send } = fakeSend({ status: "failed", error: new Error(message) });
    assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "claimed" }, message);
  }
  const { send } = fakeSend({ status: "failed", error: { message: "Stable delivery intent is already queued: x" } });
  assert.equal((await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY)).status, "unknown");
});

test("a batch the host suppressed is unknown: failed is only our own check before the host", async () => {
  const { send } = fakeSend({ status: "suppressed", results: [], receipt: receipt([]), reason: "no_visible_payload" });
  assert.deepEqual(await deliver(send, CFG, DIRECTORY, { channel: "smithy" }, BRIEF, KEY), { status: "unknown", errorKind: "other", detail: "host suppressed the batch: no_visible_payload" });
});
