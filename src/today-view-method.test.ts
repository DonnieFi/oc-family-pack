import assert from "node:assert/strict";
import { test } from "node:test";
import { todayViewMethod } from "./today-view-method.ts";
import type { TodayPayload } from "./types.ts";
import { viewerOf } from "./week-method.ts";

type Client = NonNullable<Parameters<typeof viewerOf>[0]>;
const client = (fields: Record<string, unknown>) => fields as unknown as Client;
const payload: TodayPayload = { date: "2026-10-14", highlights: ["Dentist"], exceptions: [] };

test("the Today method resolves the signed-in viewer, not a session action", async () => {
  const seen: string[] = [];
  const method = todayViewMethod(async (viewer) => {
    seen.push(viewer.kind === "person" ? `person:${viewer.username ?? ""}` : viewer.kind);
    return payload;
  });
  let answer: unknown;
  await method({ client: client({ authenticatedUserId: "riley" }), respond: (_ok, value) => (answer = value) });
  assert.deepEqual(answer, payload);
  assert.deepEqual(seen, ["person:riley"]);
  await method({ client: client({ usesSharedGatewayAuth: true }), respond: (_ok, value) => (answer = value) });
  assert.deepEqual(seen, ["person:riley", "owner"]);
});
