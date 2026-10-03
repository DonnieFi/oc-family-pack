import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectAccess, formatDetection, planAccess, runAccess } from "./access.ts";

const lanReady = {
  bind: "loopback",
  controlUi: { experimental: { customPlugins: true }, allowedOrigins: ["https://192.168.1.20"] },
  trustedProxies: ["127.0.0.1"],
  auth: {
    mode: "trusted-proxy",
    password: "SENTINEL",
    trustedProxy: { userHeader: "x-forwarded-user", allowUsers: ["alex"], allowLoopback: true },
  },
};

test("detection reads the mode from the Gateway config", () => {
  const rows: [unknown, string][] = [
    [undefined, "solo"],
    [{ auth: { mode: "none" } }, "solo"],
    [{ auth: { mode: "token", token: "SENTINEL" } }, "solo"],
    [{ auth: { mode: "password" } }, "solo"],
    [lanReady, "lan"],
    [{ auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "remote-user" } } }, "lan"],
  ];
  for (const [gateway, mode] of rows) assert.equal(detectAccess(gateway).mode, mode, JSON.stringify(gateway));
});

test("a complete LAN Gateway has no steps left and exits 0", () => {
  const found = detectAccess(lanReady);
  assert.deepEqual(found.missing, []);
  const report = formatDetection(found);
  assert.equal(report.ok, true);
  assert.match(report.text.split("\n")[0] ?? "", /^This Gateway is in LAN mode and is set up\.$/);
});

test("each missing LAN item is one named step", () => {
  const cases: [string, (g: typeof lanReady) => unknown, RegExp][] = [
    ["custom plugins", (g) => ({ ...g, controlUi: { allowedOrigins: g.controlUi.allowedOrigins } }), /customPlugins/],
    ["user header", (g) => ({ ...g, auth: { ...g.auth, trustedProxy: { ...g.auth.trustedProxy, userHeader: "remote-user" } } }), /userHeader/],
    ["allow users", (g) => ({ ...g, auth: { ...g.auth, trustedProxy: { ...g.auth.trustedProxy, allowUsers: [] } } }), /allowUsers/],
    ["allow loopback", (g) => ({ ...g, auth: { ...g.auth, trustedProxy: { ...g.auth.trustedProxy, allowLoopback: false } } }), /allowLoopback` to `true`, because the proxy runs on this machine\.$/],
    ["trusted proxies", (g) => ({ ...g, trustedProxies: [] }), /trustedProxies/],
    ["trusted proxies unset", (g) => ({ ...g, trustedProxies: undefined }), /trustedProxies/],
    ["trusted proxies with a LAN range", (g) => ({ ...g, trustedProxies: ["127.0.0.1", "192.168.1.0/24"] }), /trustedProxies/],
    ["trusted proxies with ::1", (g) => ({ ...g, trustedProxies: ["127.0.0.1", "::1"] }), /trustedProxies/],
    ["bind", (g) => ({ ...g, bind: "lan" }), /gateway\.bind/],
    ...(
      [
        ["origin unset", undefined],
        ["origin empty", []],
        ["origin wildcard", ["*"]],
        ["origin wildcard beside a good one", ["https://192.168.1.20", "*"]],
        ["origin over http", ["http://192.168.1.20"]],
        ["origin with a path", ["https://192.168.1.20/family"]],
      ] as [string, unknown][]
    ).map(([name, allowedOrigins]): [string, (g: typeof lanReady) => unknown, RegExp] => [
      name,
      (g) => ({ ...g, controlUi: { ...g.controlUi, allowedOrigins } }),
      /^Set `gateway\.controlUi\.allowedOrigins` to the one address the family opens, like `https:\/\/192\.168\.1\.20`\. It has to start with `https:\/\/`, with no `\*` and no path\.$/,
    ]),
    ["publicOrigin instead of allowedOrigins", (g) => ({ ...g, publicOrigin: "https://192.168.1.20", controlUi: { experimental: { customPlugins: true } } }), /allowedOrigins/],
    ["password", (g) => ({ ...g, auth: { ...g.auth, password: undefined } }), /gateway\.auth\.password/],
  ];
  for (const [name, change, step] of cases) {
    const found = detectAccess(change(lanReady));
    assert.equal(found.mode, "lan", name);
    assert.equal(found.missing.length, 1, name);
    assert.match(found.missing[0] ?? "", step, name);
    const report = formatDetection(found);
    assert.equal(report.ok, false, name);
    assert.equal(report.text.split("\n")[0], "This Gateway is in LAN mode. 1 step left:", name);
  }
});

test("solo needs custom plugins and a loopback bind, and an unset bind is loopback", () => {
  assert.deepEqual(detectAccess({ controlUi: { experimental: { customPlugins: true } } }).missing, []);
  assert.equal(detectAccess({ bind: "lan", controlUi: { experimental: { customPlugins: true } } }).missing.length, 1);
  assert.equal(detectAccess({}).missing.length, 1);
});

test("a Gateway with an outside sign-in stops every mode with one line and no config", () => {
  const outside =
    "This Gateway lets people sign in from outside your home network. Family Pack is local only, so it doesn't set that up. Use `openclaw family access lan` instead.";
  const triggers: unknown[] = [
    { tailscale: { mode: "serve" } },
    { tailscale: { mode: "funnel" } },
    { auth: { allowTailscale: true } },
    { ...lanReady, auth: { ...lanReady.auth, trustedProxy: { ...lanReady.auth.trustedProxy, cloudflareAccessOidc: { issuer: "i" } } } },
    { auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "cf-access-authenticated-user-email", allowUsers: ["a"] } } },
  ];
  for (const gateway of triggers) {
    for (const mode of [undefined, "solo", "lan"]) {
      const result = runAccess(gateway, mode, { parent: ["alex"] }, {});
      assert.equal(result.ok, false, JSON.stringify(gateway));
      assert.equal(result.text, outside, JSON.stringify(gateway));
      assert.equal(/tailscale|cloudflare/i.test(result.text), false);
    }
  }
  assert.equal(runAccess({ tailscale: { mode: "off" } }, undefined, {}, {}).text.includes(outside), false);
});

test("runAccess reports with no mode and plans with one", () => {
  assert.match(runAccess(lanReady, undefined, {}, {}).text, /^This Gateway is in LAN mode and is set up\./);
  assert.match(runAccess(lanReady, "lan", { parent: ["alex"] }, {}).text, /^LAN\./);
});

test("detection never claims roles are assigned", () => {
  const report = formatDetection(detectAccess(lanReady));
  assert.match(report.text, /Roles are set per person with `users\.setRole`, so they can't be checked from here\./);
});

test("no Gateway secret reaches any output", () => {
  const gateway = { ...lanReady, auth: { ...lanReady.auth, token: "SENTINEL", password: "SENTINEL" } };
  const outputs = [
    formatDetection(detectAccess(gateway)).text,
    runAccess(gateway, undefined, {}, {}).text,
    planAccess("solo", { names: ["alex"] }, {}).text,
    planAccess("lan", { parent: ["alex"], kid: ["riley"] }, {}).text,
  ];
  for (const text of outputs) assert.equal(text.includes("SENTINEL"), false);
});

test("LAN for alex and riley prints placeholders, no password, the blocks in order, and the no sign-out line", () => {
  const plan = planAccess("lan", { kid: ["riley"], parent: ["alex"] }, { port: 18790 });
  assert.equal(plan.ok, true);
  const text = plan.text;
  assert.equal(
    text.split("\n")[0],
    "LAN. Each person signs in to Caddy with their own username and password. The Gateway knows who they are, and their role decides what they can do.",
  );
  assert.match(text, /^\t\talex HASH_alex$/m);
  assert.match(text, /^\t\triley HASH_riley$/m);
  assert.ok(text.indexOf("alex HASH_alex") < text.indexOf("riley HASH_riley"));
  assert.match(text, /header_up X-Forwarded-User \{http\.auth\.user\.id\}/);
  assert.match(text, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(text, /reverse_proxy 127\.0\.0\.1:18790/);
  assert.match(text, /tls internal/);
  assert.equal(/password"\s*:/i.test(text), false);
  assert.equal(/--password/.test(text), false);
  const order = [
    "LAN mode needs a proxy on this machine that serves HTTPS and signs each person in.",
    "This uses Caddy's own certificate.",
    "Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.",
    "There's no sign-out and no way to switch accounts.",
    "Any proxy works if it's the only way to reach the Gateway,",
    "Caddyfile:",
    "Replace `LAN_ADDRESS` with this machine's address on your home network, like `192.168.1.20`. Use the same address in the Caddyfile and in `allowedOrigins`. If you add a port to the Caddyfile, add it to the origin too.",
    "Run `caddy hash-password` once for each person and paste each hash in place of its placeholder.",
    "Gateway config:",
    "Everyone starts as a guest who can only read.",
    "The shared Gateway token stops working in LAN mode.",
    "Roles:",
    "After each person signs in once, set their role:",
  ];
  let at = -1;
  for (const marker of order) {
    const next = text.indexOf(marker);
    assert.ok(next > at, `${marker} is out of order`);
    at = next;
  }
  assert.match(text, /users\.setRole --params '\{"profileId":"PROFILE_alex","role":"parent"\}'/);
  assert.match(text, /users\.setRole --params '\{"profileId":"PROFILE_riley","role":"kid"\}'/);
});

test("the LAN blocks are config openclaw accepts", () => {
  const text = planAccess("lan", { parent: ["alex"], kid: ["riley"], guest: ["sam"] }, {}).text;
  const blocks = [...text.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => JSON.parse(match[0]) as { gateway: Record<string, unknown> });
  assert.equal(blocks.length, 2);
  const [config, roles] = blocks;
  assert.deepEqual(config?.gateway, {
    bind: "loopback",
    controlUi: { experimental: { customPlugins: true }, allowedOrigins: ["https://LAN_ADDRESS"] },
    trustedProxies: ["127.0.0.1"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: "x-forwarded-user", allowUsers: ["alex", "riley", "sam"], allowLoopback: true },
    },
  });
  assert.deepEqual(roles?.gateway, {
    auth: {
      identityScopes: {
        alex: ["operator.read", "operator.write", "operator.sessions.write"],
        riley: ["operator.read", "operator.sessions.write"],
        sam: ["operator.read"],
      },
    },
    roles: {
      default: "guest",
      definitions: {
        parent: { sessions: { others: "write" }, agents: "*", scopes: ["operator.read", "operator.write", "operator.sessions.write"] },
        kid: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read", "operator.sessions.write"] },
        guest: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
      },
    },
  });
  // detectAccess on the printed config with a password added is a complete LAN Gateway.
  const merged = { ...config?.gateway, auth: { ...(config?.gateway.auth as object), password: "set" } };
  assert.deepEqual(detectAccess(merged).missing, []);
});

test("every LAN run warns that local programs can sign in as anyone, even when complete", () => {
  const warning = "Anything else running on this machine can sign in as any family member. Run only the proxy and the Gateway here.";
  const complete = formatDetection(detectAccess(lanReady));
  assert.equal(complete.ok, true);
  assert.ok(complete.text.includes(warning));
  assert.ok(formatDetection(detectAccess({ ...lanReady, trustedProxies: [] })).text.includes(warning));
  assert.ok(planAccess("lan", { parent: ["alex"] }, {}).text.includes(warning));
  assert.equal(formatDetection(detectAccess({})).text.includes(warning), false);
});

test("the LAN config has no requiredHeaders, which would not stop a local program", () => {
  assert.equal(planAccess("lan", { parent: ["alex"] }, {}).text.includes("requiredHeaders"), false);
});

test("a LAN range in trustedProxies is one step and exits 1", () => {
  const report = runAccess({ ...lanReady, trustedProxies: ["127.0.0.1", "192.168.1.0/24"] }, undefined, {}, {});
  assert.equal(report.ok, false);
  assert.match(
    report.text,
    /^- Set `gateway\.trustedProxies` to only `127\.0\.0\.1`, so nothing else on your network can pretend to be the proxy\.$/m,
  );
});

test("LAN says it needs a proxy, names Caddy as the example, and gives the rules for any proxy", () => {
  const lines = planAccess("lan", { parent: ["alex"] }, {}).text.split("\n");
  assert.equal(
    lines[1],
    "LAN mode needs a proxy on this machine that serves HTTPS and signs each person in. The example below uses Caddy (https://caddyserver.com/docs/install).",
  );
  const caddy = lines.indexOf("Caddyfile:");
  assert.equal(
    lines[caddy - 1],
    "Any proxy works if it's the only way to reach the Gateway, signs each person in, sends their username in `X-Forwarded-User`, and replaces any `X-Forwarded-User` or `X-Forwarded-For` the browser sends.",
  );
});

test("the Caddyfile always uses its own certificate on LAN_ADDRESS", () => {
  const text = planAccess("lan", { parent: ["alex"] }, {}).text;
  assert.match(text, /^LAN_ADDRESS \{\n\ttls internal$/m);
  assert.ok(
    text.includes(
      "This uses Caddy's own certificate. Install Caddy's root certificate once on every family phone and laptop, or the Family page won't load. It's `pki/authorities/local/root.crt` in Caddy's data folder. Nothing on this machine has to be reachable from the internet.",
    ),
  );
  assert.equal(/domain|DNS-01/i.test(text), false);
});

test("a bare https origin with a port is a finished step", () => {
  assert.deepEqual(detectAccess({ ...lanReady, controlUi: { ...lanReady.controlUi, allowedOrigins: ["https://192.168.1.20:8443"] } }).missing, []);
});

test("the printed origin is the Caddyfile's site address over https", () => {
  const text = planAccess("lan", { parent: ["alex"] }, {}).text;
  const site = /^Caddyfile:\n(\S+) \{$/m.exec(text)?.[1];
  const config = [...text.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => JSON.parse(match[0]))[0] as {
    gateway: { controlUi: { allowedOrigins: string[] } };
  };
  assert.ok(site);
  assert.deepEqual(config.gateway.controlUi.allowedOrigins, [`https://${site}`]);
});

test("names without a role are guests", () => {
  const text = planAccess("lan", { names: ["sam"] }, {}).text;
  assert.match(text, /"profileId":"PROFILE_sam","role":"guest"/);
});

test("Alex Smith is rejected with the username line and exit 1", () => {
  const plan = planAccess("lan", { parent: ["Alex Smith"] }, {});
  assert.equal(plan.ok, false);
  assert.equal(
    plan.text,
    "Usernames use lower-case letters, numbers, dots, dashes or underscores. Try `alex`, not `Alex Smith`.\nEach person sees their username as their name in the Control UI, so use what the family calls them.",
  );
});

test("the same name under two roles is rejected", () => {
  const plan = planAccess("lan", { parent: ["alex"], kid: ["alex"] }, {});
  assert.equal(plan.ok, false);
  assert.match(plan.text, /alex/);
});

test("LAN with nobody listed is rejected", () => {
  assert.equal(planAccess("lan", {}, {}).ok, false);
});

test("an unknown mode is rejected", () => {
  assert.equal(planAccess("cloud", {}, {}).ok, false);
  assert.equal(planAccess("internet", { parent: ["alex"] }, {}).text, "Pick a mode: `solo` or `lan`.");
});

test("solo opens with the mode line", () => {
  assert.equal(
    planAccess("solo", {}, {}).text.split("\n")[0],
    "Solo. Everyone who opens the Control UI is the owner. Family members use Discord, where the bot knows who's talking.",
  );
});

test("only outsideSignIn names the outside services", () => {
  const source = readFileSync(new URL("./access.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function outsideSignIn");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start);
  const rest = source.slice(0, start) + source.slice(end);
  assert.equal(/tailscale|cloudflare/i.test(rest), false);
});

test("the access module can't touch files, processes, or the Gateway", () => {
  const source = readFileSync(new URL("./access.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, []);
});
