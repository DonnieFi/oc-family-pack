import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { pageWriteMethod } from "./page-write-method.ts";
import type { Requester } from "./requester.ts";
import { VIEW_ONLY } from "./write-gate.ts";
import { viewerOf } from "./week-method.ts";

const config = parseConfig({
  timezone: "UTC",
  members: [
    { id: "alex", name: "Alex", role: "parent", profileId: "alex" },
    { id: "riley", name: "Riley", role: "kid", profileId: "riley" },
  ],
  calendars: [{ key: "c0", id: "family@example.com", label: "Family", kind: "shared", owners: [] }],
});

type Client = NonNullable<Parameters<typeof viewerOf>[0]>;
const client = (fields: Record<string, unknown>) => fields as unknown as Client;

const input = {
  op: "create" as const,
  requestId: "req-1",
  calendarKey: "c0",
  title: "Dentist",
  start: "2026-10-14T13:00:00Z",
  end: "2026-10-14T14:00:00Z",
};

async function call(fields: Record<string, unknown>) {
  let answer: { ok: boolean; payload: unknown } | undefined;
  let seen: Requester | undefined;
  const method = pageWriteMethod(
    () => config,
    async (_input, _context, requester) => {
      seen = requester;
      return { ok: true, message: "ok" };
    },
  );
  await method({
    params: input,
    client: client(fields),
    respond: (ok, payload) => {
      answer = { ok, payload };
    },
  });
  return { answer, seen };
}

test("a parent or the shared owner may use pageWrite; a roster kid with write is view-only", async () => {
  const parent = await call({ authenticatedUserId: "alex", connect: { scopes: ["operator.write"] } });
  assert.deepEqual(parent.answer?.payload, { ok: true, message: "ok" });
  assert.equal(parent.seen?.from, "page");
  assert.equal(parent.seen?.from === "page" ? parent.seen.role : undefined, "parent");
  assert.equal(parent.seen?.from === "page" ? parent.seen.memberId : undefined, "alex");

  const owner = await call({ usesSharedGatewayAuth: true, connect: { scopes: ["operator.write"] } });
  assert.deepEqual(owner.answer?.payload, { ok: true, message: "ok" });
  assert.equal(owner.seen?.from === "page" ? owner.seen.role : undefined, "parent");

  const kid = await call({ authenticatedUserId: "riley", connect: { scopes: ["operator.write"] } });
  assert.deepEqual(kid.answer?.payload, { ok: false, message: VIEW_ONLY });
  assert.equal(kid.seen, undefined);
});
