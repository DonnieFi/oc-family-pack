import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_PORTS, pickRefusal } from "./smoke-ports.ts";

const free = async () => true;

test("the live Gateway holds 18789 and its sidecar 18799", () => {
  assert.deepEqual(LIVE_PORTS, [18789, 18799]);
});

test("a random pick of 18779 is refused, because its sidecar would land on 18789", async () => {
  assert.match((await pickRefusal(18779, free)) ?? "", /18789/);
});

test("a random pick on a live port or with a busy sidecar is refused", async () => {
  assert.notEqual(await pickRefusal(18789, free), undefined);
  assert.notEqual(await pickRefusal(18799, free), undefined);
  assert.match((await pickRefusal(40000, async (port) => port !== 40010)) ?? "", /40010/);
});

test("a pick whose port and sidecar are both free and not live is accepted", async () => {
  assert.equal(await pickRefusal(19789, free), undefined);
});
