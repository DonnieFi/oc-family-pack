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

const HOST = "2026.10.10-beta.3";
const PLAIN = ">=2026.10.5 <2026.11";

test("the pinned host is the tested beta, and a plain 2026.10 range does not accept it", () => {
  assert.equal(pkg.devDependencies.openclaw, HOST);
  assert.equal(pkg.openclaw.build.openclawVersion, HOST);
  assert.equal(pkg.openclaw.install.minHostVersion, `>=${HOST}`);
  assert.equal(pkg.openclaw.compat.pluginApi, `>=${HOST}`);
  assert.equal(pkg.peerDependencies.openclaw, `>=${HOST} <2026.11`);
  assert.equal(satisfies(HOST, PLAIN), false);
  assert.equal(satisfies(HOST, pkg.peerDependencies.openclaw), true);
  assert.equal(satisfies("2026.10.6", pkg.peerDependencies.openclaw), false);
  assert.equal(satisfies("2026.10.10", pkg.peerDependencies.openclaw), true);
  assert.equal(satisfies("2026.11.0", pkg.peerDependencies.openclaw), false);
  assert.equal(satisfies("2026.11.0-beta.1", pkg.peerDependencies.openclaw), false);
});
