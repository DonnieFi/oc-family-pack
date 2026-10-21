import assert from "node:assert/strict";
import { test } from "node:test";
import { commandLooksLikeGateway, guardRefusal, integersInArgs } from "./isolated-guard.ts";

test("the harness refuses the live state dir, the live ports, and a live gateway pid", () => {
  const live = "/home/operator/.openclaw";
  assert.equal(
    guardRefusal({ stateDir: live, liveStateDir: live, args: ["plugins", "build"] }),
    "refusing to use the live Gateway state directory",
  );
  assert.equal(guardRefusal({ stateDir: "/tmp/ocfp-oc-state", liveStateDir: live, args: ["plugins", "build"] }), undefined);
  assert.equal(
    guardRefusal({ stateDir: "/tmp/ocfp-oc-state", liveStateDir: live, args: ["gateway", "--port", "18789"] }),
    "refusing port 18789, which belongs to the live Gateway",
  );
  assert.equal(
    guardRefusal({ stateDir: "/tmp/ocfp-oc-state", liveStateDir: live, args: ["gateway", "--port=18799"] }),
    "refusing port 18799, which belongs to the live Gateway",
  );
  assert.equal(guardRefusal({ stateDir: "/tmp/ocfp-oc-state", liveStateDir: live, args: ["gateway", "--port", "19789"] }), undefined);
  assert.equal(
    guardRefusal({
      stateDir: "/tmp/ocfp-oc-state",
      liveStateDir: live,
      args: ["gateway", "stop", "4242"],
      isLiveGatewayPid: (pid) => pid === 4242,
    }),
    "refusing pid 4242, which is the live Gateway",
  );
  assert.equal(
    guardRefusal({
      stateDir: "/tmp/ocfp-oc-state",
      liveStateDir: live,
      args: ["4242"],
      isLiveGatewayPid: () => false,
    }),
    undefined,
  );
  assert.deepEqual(integersInArgs(["plugins", "build"]), []);
  assert.equal(commandLooksLikeGateway("openclaw gateway --port 18789"), true);
  assert.equal(commandLooksLikeGateway("openclaw plugins build"), false);
});
