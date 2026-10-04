// Host contract for deliver(): a real isolated Gateway (temp state, free port, never the live
// 18789) with @openclaw/discord pointed at a stand-in Discord REST API on loopback, and a probe
// plugin calling the built dist/discord-delivery.js. A send completes, the Gateway is SIGKILLed,
// and after a restart the same key must come back claimed with Discord having seen it once. That
// fails if completionRetention is dropped (the completed entry is gone and the resend posts again)
// or if the host rewords its claimed error (deliver() would log it unknown, not claimed).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedGatewayEnv } from "../scripts/isolated-env.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = process.env.OCFP_SMOKE_HOST_BIN ?? join(ROOT, "node_modules", ".bin", "openclaw");
const DISCORD_PLUGIN = process.env.OCFP_DISCORD_PLUGIN ?? "@openclaw/discord@2026.9.7";
const CHANNEL = "222222222222222222";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = netServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

test("a completed send, a SIGKILL and a restart: the same key is claimed and Discord saw it once", { timeout: 600_000 }, async () => {
  const posts: { channel: string; content: unknown }[] = [];
  const discord = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/api\/v10/, "");
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const message = /^\/channels\/(\d+)\/messages$/.exec(path);
      if (req.method === "POST" && message) {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        posts.push({ channel: message[1]!, content: body.content });
        return reply(200, { id: String(900000000000000000n + BigInt(posts.length)), channel_id: message[1], type: 0, content: body.content ?? "", embeds: [], timestamp: new Date().toISOString(), author: { id: "999999999999999990", username: "bot", bot: true } });
      }
      const channel = /^\/channels\/(\d+)$/.exec(path);
      if (req.method === "GET" && channel) return reply(200, { id: channel[1], type: 0, guild_id: "888888888888888888", name: "family" });
      if (req.method === "GET" && path === "/users/@me") return reply(200, { id: "999999999999999990", username: "bot", bot: true });
      return reply(path === "/gateway/bot" ? 401 : 404, { message: "no", code: 0 });
    });
  });
  const discordPort = await freePort();
  await new Promise<void>((resolve) => discord.listen(discordPort, "127.0.0.1", resolve));

  const work = mkdtempSync(join(tmpdir(), "ocfp-delivery-host-"));
  const stateDir = join(work, "state");
  const configPath = join(work, "config.json");
  const requests = join(work, "requests");
  const results = join(work, "results");
  for (const dir of [stateDir, requests, results]) mkdirSync(dir);
  const port = await freePort();
  assert.notEqual(port, 18789, "never the live Gateway port");
  const env = isolatedGatewayEnv(process.env, { stateDir, configPath });
  for (const key of Object.keys(env)) if (/DISCORD/i.test(key)) delete env[key];
  env.DISCORD_API_URL = `http://127.0.0.1:${discordPort}/api/v10`;
  const oc = (args: string[]) => spawnSync(HOST, args, { env, encoding: "utf8", timeout: 300_000 });

  const probe = join(work, "probe");
  mkdirSync(join(probe, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules", "openclaw"), join(probe, "node_modules", "openclaw"));
  const manifest = { id: "ocfp-delivery-probe", name: "Delivery probe", description: "deliver() host contract", activation: { onStartup: true }, configSchema: { type: "object", additionalProperties: false, properties: {} } };
  writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "ocfp-delivery-probe", version: "0.0.0", private: true, type: "module", openclaw: { extensions: ["./index.js"] } }));
  writeFileSync(join(probe, "openclaw.plugin.json"), JSON.stringify(manifest));
  writeFileSync(
    join(probe, "index.js"),
    `import { appendFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { deliver } from ${JSON.stringify(pathToFileURL(join(ROOT, "dist", "discord-delivery.js")).href)};
const REQ = ${JSON.stringify(requests)}, RES = ${JSON.stringify(results)};
const DIRECTORY = { members: [], channels: { family: ${JSON.stringify(CHANNEL)} } };
export default definePluginEntry({
  id: "ocfp-delivery-probe", name: "Delivery probe", description: "deliver() host contract",
  register(api) {
    let timer;
    api.registerService({
      id: "delivery-probe",
      start(ctx) {
        appendFileSync(join(RES, "started"), process.pid + "\\n");
        timer = setInterval(async () => {
          for (const file of readdirSync(REQ)) {
            if (!file.endsWith(".json")) continue;
            renameSync(join(REQ, file), join(REQ, file + ".taken"));
            const request = JSON.parse(readFileSync(join(REQ, file + ".taken"), "utf8"));
            let outcome;
            try { outcome = await deliver(sendDurableMessageBatch, ctx.config, DIRECTORY, { channel: "family" }, [{ text: request.text }], request.key); }
            catch (error) { outcome = { threw: String(error) }; }
            writeFileSync(join(RES, request.id + ".json"), JSON.stringify(outcome));
            if (request.killAfter) process.kill(process.pid, "SIGKILL");
          }
        }, 200);
      },
      stop() { clearInterval(timer); },
    });
  },
});
`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      logging: { file: join(work, "openclaw.log") },
      gateway: { mode: "local", port, auth: { mode: "token", token: "delivery-host-test-token" } },
      channels: { discord: { enabled: true, token: "delivery-host-fake-token" } },
      plugins: { entries: { discord: { enabled: true }, "ocfp-delivery-probe": { enabled: true } } },
    }),
  );

  let gateway: ChildProcess | undefined;
  let boots = 0;
  const started = () => (existsSync(join(results, "started")) ? readFileSync(join(results, "started"), "utf8").trim().split("\n").length : 0);
  const boot = async () => {
    boots += 1;
    const before = started();
    const logFile = join(work, `gateway-${boots}.log`);
    gateway = spawn(HOST, ["gateway", "run", "--port", String(port), "--bind", "loopback"], { env, stdio: ["ignore", openSync(logFile, "w"), openSync(logFile, "a")], detached: true });
    for (let i = 0; started() <= before; i++) {
      if (i > 900 || gateway.exitCode !== null) throw new Error(`gateway ${boots} did not start the probe:\n${readFileSync(logFile, "utf8").slice(-3000)}`);
      await sleep(200);
    }
  };
  const exited = async () => {
    for (let i = 0; i < 150 && gateway && gateway.exitCode === null && gateway.signalCode === null; i++) await sleep(200);
  };
  let asked = 0;
  const ask = async (request: { key: string; text: string; killAfter?: boolean }) => {
    const id = `r${(asked += 1)}`;
    writeFileSync(join(requests, `${id}.json`), JSON.stringify({ id, ...request }));
    for (let i = 0; i < 600; i++) {
      if (existsSync(join(results, `${id}.json`))) return JSON.parse(readFileSync(join(results, `${id}.json`), "utf8")) as { status: string };
      await sleep(200);
    }
    throw new Error(`no answer for ${id}`);
  };

  try {
    for (const spec of [DISCORD_PLUGIN, probe]) {
      const installed = oc(["plugins", "install", spec, ...(spec === probe ? ["--force", "--link"] : []), "--accept-capabilities"]);
      assert.equal(installed.status, 0, `${spec}: ${installed.stderr}${installed.stdout}`);
    }
    await boot();
    const text = "Daily brief host-contract probe";
    const first = await ask({ key: "daily-summary:2026-11-01", text, killAfter: true });
    assert.equal(first.status, "sent");
    await exited();
    assert.equal(gateway?.signalCode, "SIGKILL");
    await boot();
    // Recovery runs at boot; a completed entry is not replayed.
    await sleep(5_000);
    const again = await ask({ key: "daily-summary:2026-11-01", text });
    assert.deepEqual(again, { status: "claimed" }, "the host must still hold the completed key, and its claimed error must keep its wording");
    assert.equal(posts.filter((post) => post.content === text).length, 1);
    const other = await ask({ key: "daily-summary:2026-11-02", text });
    assert.equal(other.status, "sent");
    assert.ok(posts.every((post) => post.channel === CHANNEL));
  } finally {
    if (gateway?.pid && gateway.exitCode === null && gateway.signalCode === null) {
      try {
        process.kill(-gateway.pid, "SIGKILL");
      } catch {}
      await exited();
    }
    discord.close();
    rmSync(work, { recursive: true, force: true });
  }
});
