import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { satisfies } = require("semver") as { satisfies: (version: string, range: string) => boolean };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  peerDependencies: { openclaw: string };
  devDependencies: { openclaw: string };
  openclaw: { install: { minHostVersion: string }; compat: { pluginApi: string }; build: { openclawVersion: string } };
};

const HOST = "2026.11.1";
const PEER = `>=${HOST} <2026.12`;

test("the pinned host is the tested stable, and the peer range admits this 2026.11 line only", () => {
  assert.equal(pkg.devDependencies.openclaw, HOST);
  assert.equal(pkg.openclaw.build.openclawVersion, HOST);
  assert.equal(pkg.openclaw.install.minHostVersion, `>=${HOST}`);
  assert.equal(pkg.openclaw.compat.pluginApi, `>=${HOST}`);
  assert.equal(pkg.peerDependencies.openclaw, PEER);
  assert.equal(satisfies(HOST, PEER), true);
  assert.equal(satisfies("2026.11.2", PEER), true);
  assert.equal(satisfies("2026.11.0", PEER), false);
  assert.equal(satisfies("2026.10.10", PEER), false);
  assert.equal(satisfies("2026.12.0", PEER), false);
});
