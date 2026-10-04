import assert from "node:assert/strict";
import { test } from "node:test";
import { DELIVERY_EMPTY, DELIVERY_UNAVAILABLE, deliveryStatusLine, deliveryStatusMethod } from "./delivery-status.ts";
import type { DeliveryKind, DeliveryStatus } from "./store.ts";

const ROSTER = [{ profileId: "alex", displayName: "Alex" }];

const NAMED: Record<DeliveryStatus, string> = {
  sent: "Daily brief sent to Alex.",
  partial: "Daily brief partly sent to Alex.",
  failed: "Daily brief did not send to Alex.",
  held: "Daily brief to Alex is waiting to send.",
  unknown: "Daily brief to Alex may not have been sent.",
};

const PLAIN: Record<DeliveryStatus, string> = {
  sent: "Reminder sent.",
  partial: "Reminder partly sent.",
  failed: "Reminder did not send.",
  held: "Reminder is waiting to send.",
  unknown: "Reminder may not have been sent.",
};

test("the delivery line names the kind and who it was for, and hides every other target", () => {
  for (const [status, line] of Object.entries(NAMED) as [DeliveryStatus, string][]) {
    assert.deepEqual(deliveryStatusLine({ kind: "daily", status, target: "alex" }, ROSTER), { line, failed: status === "failed" });
  }
  for (const [status, line] of Object.entries(PLAIN) as [DeliveryStatus, string][]) {
    const view = deliveryStatusLine({ kind: "reminder", status, target: "summary" }, ROSTER);
    assert.deepEqual(view, { line, failed: status === "failed" });
    assert.equal(view?.line.includes("summary"), false);
  }
  assert.equal(deliveryStatusLine({ kind: "weekly", status: "sent", target: "200000000000000099" }, ROSTER)?.line, "Weekly brief sent.");
  assert.equal(deliveryStatusLine({ kind: "household", status: "partial", target: "alex" }, [{ profileId: "alex", displayName: "  " }])?.line, "Household brief partly sent.");
  assert.equal(deliveryStatusLine({ kind: "alert", status: "held", target: "alex" }, ROSTER)?.line, "Alert to Alex is waiting to send.");
  assert.equal(deliveryStatusLine({ kind: "nope" as DeliveryKind, status: "sent", target: "alex" }, ROSTER), undefined);
});

test("the page method returns a sentence, the empty line, or the check failure, and never the target", async () => {
  const answers: unknown[] = [];
  const respond = (ok: boolean, payload: unknown) => {
    answers.push({ ok, payload });
  };
  const roster = () => ROSTER;
  await deliveryStatusMethod(() => ({ latestDelivery: async () => ({ kind: "weekly", status: "partial", target: "alex" }) }), roster)({ respond });
  await deliveryStatusMethod(() => ({ latestDelivery: async () => undefined }), roster)({ respond });
  await deliveryStatusMethod(() => undefined, roster)({ respond });
  await deliveryStatusMethod(() => ({
    latestDelivery: async () => {
      throw new Error("disk");
    },
  }), roster)({ respond });
  await deliveryStatusMethod(() => ({ latestDelivery: async () => ({ kind: "daily", status: "sent", target: "200000000000000099" }) }), roster)({ respond });
  assert.deepEqual(answers, [
    { ok: true, payload: { line: "Weekly brief partly sent to Alex.", failed: false } },
    { ok: true, payload: { line: DELIVERY_EMPTY, failed: false } },
    { ok: true, payload: { line: DELIVERY_UNAVAILABLE, failed: false } },
    { ok: true, payload: { line: DELIVERY_UNAVAILABLE, failed: false } },
    { ok: true, payload: { line: "Daily brief sent.", failed: false } },
  ]);
  assert.equal(JSON.stringify(answers).includes("200000000000000099"), false);
  assert.equal(JSON.stringify(answers).includes("disk"), false);
});
