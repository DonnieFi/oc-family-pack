import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { familyWeek } from "./handlers.ts";
import type { WeekPayload } from "./types.ts";
import { viewerOf, weekMethod } from "./week-method.ts";

type Client = Parameters<typeof viewerOf>[0];
const client = (fields: Record<string, unknown>) => fields as unknown as Client;
// Shapes as the published 2026.9.7 host builds them: authPolicy carries only
// generation and verifiedIdentity, never an authMethod.
const proxied = (username: string) =>
  client({ usesSharedGatewayAuth: true, authenticatedUserId: username, authPolicy: { generation: "g", verifiedIdentity: username } });
const TOKEN = client({ usesSharedGatewayAuth: true, authPolicy: { generation: "g" } });

test("the shared secret with no signed-in user is the owner; an attested user is that person", () => {
  assert.deepEqual(viewerOf(TOKEN), { kind: "owner" });
  assert.deepEqual(viewerOf(client({ usesSharedGatewayAuth: true, isDeviceTokenAuth: true, authPolicy: { generation: "g" } })), { kind: "owner" });
  assert.deepEqual(viewerOf(proxied("alex")), { kind: "person", username: "alex" });
  assert.deepEqual(viewerOf(client({ usesSharedGatewayAuth: false, authenticatedUserId: "alex" })), { kind: "person", username: "alex" });
  for (const other of [
    client({ usesSharedGatewayAuth: false, authPolicy: { generation: "g" } }),
    // A CLI-paired device token is not shared auth, so it is a guest.
    client({ usesSharedGatewayAuth: false, isDeviceTokenAuth: true, authPolicy: { generation: "g" } }),
    client({ usesSharedGatewayAuth: true, authenticatedUserId: "" }),
    client({ usesSharedGatewayAuth: true, authenticatedUserId: "  " }),
    // An authMethod is not part of the published client; it never makes an owner.
    client({ usesSharedGatewayAuth: false, authPolicy: { generation: "g", authMethod: "token" } }),
    client({}),
    null,
  ]) {
    assert.deepEqual(viewerOf(other), { kind: "person", username: undefined }, JSON.stringify(other));
  }
});

const config = parseConfig({ demo: true, timezone: "America/Toronto" });
const method = weekMethod(familyWeek(config, { now: () => Date.parse("2026-09-30T16:00:00Z"), fetchWeather: async () => new Response("", { status: 503 }) }));

async function call(params: Record<string, unknown>, who: Client) {
  let reply: { ok: boolean; payload: unknown; error: { code?: string } | undefined } | undefined;
  await method({ params, client: who, respond: (ok, payload, error) => (reply = { ok, payload, error }) });
  assert.ok(reply, "the method never responded");
  return reply;
}
const labels = async (who: Client) => {
  const reply = await call({ start: "2026-10-01" }, who);
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return (reply.payload as WeekPayload).calendars.map((calendar) => calendar.label).sort();
};
const EVERYTHING = ["Alex", "Family", "Jordan", "Riley", "Sam", "School"];

test("a kid's family.week has shared, school and their own calendars only", async () => {
  assert.deepEqual(await labels(proxied("riley")), ["Family", "Riley", "School"]);
});

test("a parent and the token owner get the whole household", async () => {
  assert.deepEqual(await labels(proxied("alex")), EVERYTHING);
  assert.deepEqual(await labels(TOKEN), EVERYTHING);
});

test("a session with neither the shared secret nor a signed-in user sees shared calendars only", async () => {
  assert.deepEqual(await labels(client({ usesSharedGatewayAuth: false, authPolicy: { generation: "g" } })), ["Family"]);
});

test("a forged member id in the params is refused, not used", async () => {
  for (const forged of [{ profileId: "alex" }, { viewer: { kind: "owner" } }, { start: "2026-10-01", username: "alex" }]) {
    const reply = await call(forged, proxied("riley"));
    assert.equal(reply.ok, false, JSON.stringify(forged));
    assert.equal(reply.error?.code, "INVALID_REQUEST");
  }
});

test("a start outside what Family can show is a request error", async () => {
  const reply = await call({ start: "9999-12-31" }, TOKEN);
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.code, "INVALID_REQUEST");
});
