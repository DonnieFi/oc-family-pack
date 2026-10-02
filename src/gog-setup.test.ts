import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseGog, formatGogSetup, gogAccount, registerFamilyCli, type RunGog } from "./gog-setup.ts";

function scripted(steps: Record<string, { stdout?: string; stderr?: string; code?: string | number }>): RunGog {
  return async (_file, args) => {
    const key = args.join(" ");
    const step = steps[key];
    if (!step) throw new Error(`unexpected gog ${key}`);
    if (step.code !== undefined) {
      const error = new Error("gog failed") as Error & { code?: string | number; stderr?: string; stdout?: string };
      error.code = step.code;
      error.stderr = step.stderr ?? "";
      error.stdout = step.stdout ?? "";
      throw error;
    }
    return { stdout: step.stdout ?? "" };
  };
}

const doctorOk = JSON.stringify({
  checks: [
    { name: "keyring.backend", status: "ok" },
    { name: "tokens", status: "ok" },
  ],
});
const doctorKeyring = JSON.stringify({
  checks: [{ name: "keyring.password", status: "error", detail: "/home/someone/.local/share/gogcli/keyring" }],
});
const clients = JSON.stringify({ clients: [{ client: "default" }] });
const noClients = JSON.stringify({ clients: [] });
const calendarAccount = JSON.stringify({ accounts: [{ email: "person@example.com", services: ["calendar"] }] });
const readonlyAccount = JSON.stringify({ accounts: [{ email: "person@example.com", services: ["gmail"], readonly: true }] });
const noAccounts = JSON.stringify({ accounts: [] });

test("a missing gog binary is the install command and nothing else is run", async () => {
  const calls: string[][] = [];
  const plan = await diagnoseGog(async (file, args) => {
    calls.push([file, ...args]);
    const error = new Error("spawn") as Error & { code: string };
    error.code = "ENOENT";
    throw error;
  }, { gogPath: "gog" });
  assert.equal(plan.status, "missing");
  assert.equal(plan.command, "brew install openclaw/tap/gogcli");
  assert.deepEqual(calls, [["gog", "auth", "doctor", "--json", "--no-input"]]);
  assert.equal(formatGogSetup(plan).includes(plan.command), true);
});

test("no OAuth client prints credentials set on a headless host and setup on a desktop", async () => {
  const headless = await diagnoseGog(scripted({
    "auth doctor --json --no-input": { stdout: doctorOk },
    "auth credentials list --json --no-input": { stdout: noClients },
  }));
  const desktop = await diagnoseGog(
    scripted({
      "auth doctor --json --no-input": { stdout: doctorOk },
      "auth credentials list --json --no-input": { code: 1, stderr: "No OAuth client credentials stored" },
    }),
    { headless: false },
  );
  assert.equal(headless.command, "gog auth credentials set client_secret.json");
  assert.equal(desktop.command, "gog auth setup");
  assert.equal(headless.command.includes("--readonly"), false);
});

test("a keyring error is reported without copying doctor paths", async () => {
  const plan = await diagnoseGog(scripted({ "auth doctor --json --no-input": { stdout: doctorKeyring } }));
  const text = formatGogSetup(plan);
  assert.equal(plan.status, "keyring");
  assert.equal(plan.command, "gog auth keyring file");
  assert.equal(text.includes("/home/"), false);
  assert.equal(text.includes("GOG_KEYRING_PASSWORD"), true);
});

test("no stored account authorizes calendar without --readonly, and a headless host uses --remote", async () => {
  const run = scripted({
    "auth doctor --json --no-input": { stdout: doctorOk },
    "auth credentials list --json --no-input": { stdout: clients },
    "auth list --json --no-input": { stdout: noAccounts },
  });
  const headless = await diagnoseGog(run, { email: "person@example.com" });
  const desktop = await diagnoseGog(run, { email: "person@example.com", headless: false });
  assert.equal(headless.command, "gog auth add person@example.com --services calendar --remote");
  assert.equal(desktop.command, "gog auth add person@example.com --services calendar");
  assert.equal(headless.command.includes("--readonly"), false);
  assert.equal(gogAccount("-inject@example.com"), "you@example.com");
  assert.equal(gogAccount("not an email"), "you@example.com");
});

test("a read-only grant asks for calendar consent again", async () => {
  const plan = await diagnoseGog(scripted({
    "auth doctor --json --no-input": { stdout: doctorOk },
    "auth credentials list --json --no-input": { stdout: clients },
    "auth list --json --no-input": { stdout: readonlyAccount },
  }));
  assert.equal(plan.status, "readonly");
  assert.equal(plan.command, "gog auth add you@example.com --services calendar --remote --force-consent");
  assert.equal(plan.command.includes("--readonly"), false);
});

test("a usable calendar account ends at the calendar list", async () => {
  const calls: string[] = [];
  const plan = await diagnoseGog(async (_file, args) => {
    calls.push(args.join(" "));
    if (args[0] === "auth" && args[1] === "doctor") return { stdout: doctorOk };
    if (args[1] === "credentials") return { stdout: clients };
    if (args[1] === "list") return { stdout: calendarAccount };
    if (args[0] === "calendar") return { stdout: JSON.stringify({ calendars: [{ id: "hidden@example.com" }] }) };
    throw new Error(args.join(" "));
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.command, "gog calendar calendars --json --no-input");
  assert.equal(formatGogSetup(plan).includes("hidden@example.com"), false);
  assert.deepEqual(calls.at(-1), "calendar calendars --json --no-input");
});

test("openclaw family gog prints the plan and sets a failing exit until gog is ready", async () => {
  const lines: string[] = [];
  let action: ((opts: { account?: string; desktop?: boolean }) => void | Promise<void>) | undefined;
  const command = () => {
    const node = {
      description: () => node,
      command: () => node,
      option: () => node,
      action: (fn: (opts: { account?: string; desktop?: boolean }) => void | Promise<void>) => {
        action = fn;
        return node;
      },
    };
    return node;
  };
  registerFamilyCli({ command }, {
    run: async () => {
      const error = new Error("missing") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    },
    write: (text) => lines.push(text),
  });
  assert.ok(action);
  const previous = process.exitCode;
  await action({});
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
  assert.equal(lines[0]?.split("\n").at(-1), "Next: brew install openclaw/tap/gogcli");
});
