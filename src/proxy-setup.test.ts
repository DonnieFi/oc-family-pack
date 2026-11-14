import test from "node:test";
import assert from "node:assert/strict";
import { describeCaddy, installCaddy, probeCaddy, type ProxyRunner } from "./proxy-setup.ts";

const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
test("detects Caddy but does not claim the proxy is ready", async () => {
  const result = await probeCaddy(async () => ({ stdout: "v2.11.9 h1:example\n" }), "win32");
  assert.equal(result.status, "installed");
  assert.match(describeCaddy(result), /not proof of a trusted, configured or running proxy/);
});
test("Windows checks the user winget link when the current PATH is stale", async () => {
  const calls: string[] = [];
  const result = await probeCaddy(async (file) => { calls.push(file); if (calls.length === 1) throw missing; return { stdout: "v2.11.9" }; }, "win32", "C:\\Users\\example\\AppData\\Local");
  assert.equal(result.status, "installed");
  assert.match(calls[1]!, /WinGet\\Links\\caddy\.exe$/);
});
test("missing, invalid output, and permission errors stay distinct", async () => {
  assert.equal((await probeCaddy(async () => { throw missing; }, "linux")).status, "missing");
  assert.equal((await probeCaddy(async () => ({ stdout: "not caddy" }), "linux")).status, "unknown");
  assert.equal((await probeCaddy(async () => { throw Object.assign(new Error(), { code: "EACCES" }); }, "linux")).status, "unknown");
});
test("installation is explicit, idempotent, Windows-only, and rechecks availability", async () => {
  const calls: string[][] = [];
  const run: ProxyRunner = async (file, args) => { calls.push([file, ...args]); return { stdout: file === "winget.exe" ? "installed" : "v2.11.9" }; };
  assert.equal((await installCaddy(run, { status: "missing" }, false, "win32")).ok, false);
  assert.equal((await installCaddy(run, { status: "unknown" }, true, "win32")).ok, false);
  assert.equal((await installCaddy(run, { status: "missing" }, true, "linux")).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await installCaddy(run, { status: "missing" }, true, "win32")).ok, true);
  assert.equal(calls[0]?.[0], "winget.exe");
  assert.equal(calls[1]?.[1], "version");
  assert.equal((await installCaddy(run, { status: "installed", version: "v2.11.9", executable: "caddy.exe" }, true, "win32")).ok, true);
  assert.equal(calls.length, 2);
});
test("installer failure never claims success", async () => {
  assert.equal((await installCaddy(async () => { throw new Error("denied"); }, { status: "missing" }, true, "win32")).ok, false);
});

test("proxy preflight requires valid HTTPS, rejects anonymous access and never reports role readiness", async () => {
  const { verifyProxy } = await import("./proxy-setup.ts");
  const input = { url: "https://192.0.2.20:8443", username: "alex", password: "SECRET", ca: "PUBLIC CA" };
  let requests = 0;
  const good = await verifyProxy(async (url, _ca, auth) => { assert.equal(url.pathname, "/__openclaw_family_proxy_check"); requests++; return auth ? 204 : 401; }, input);
  assert.equal(good.ok, true);
  assert.match(good.message, /does not prove Gateway identity/);
  assert.equal(good.message.includes(input.password), false);
  assert.equal(requests, 2);
  assert.equal((await verifyProxy(async () => 200, input)).ok, false);
  assert.equal((await verifyProxy(async (_url, _ca, auth) => auth ? 401 : 401, input)).ok, false);
  assert.equal((await verifyProxy(async () => { throw new Error("TLS"); }, input)).ok, false);
  assert.equal((await verifyProxy(async () => 200, { ...input, url: "http://example.test" })).ok, false);
  assert.equal((await verifyProxy(async () => 200, { ...input, url: "https://example.test/path" })).ok, false);
});
