import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createStamper, STAMP_PARAM } from "./approval-stamp.ts";
import type { RunGog } from "./calendar-gog.ts";
import {
  APPROVAL_DESCRIPTION_MAX,
  APPROVAL_TIMEOUT_MS,
  APPROVAL_TITLE_MAX,
  CALENDAR_CREATE_TOOL,
  CALENDAR_HOOK_PRIORITY,
  CalendarCreateInputSchema,
  deriveBaseKey,
  factsFromHook,
  factsFromTool,
  registerCalendarWrite,
  type ApprovalResolution,
  type CalendarTool,
  type CalendarWriteApi,
  type CalendarWriteDeps,
  type HookContext,
  type HookEvent,
  type HookResult,
  type ToolContext,
} from "./calendar-create.ts";
import { parseConfig } from "./config.ts";
import { grantHolder, type GrantHolder } from "./grant.ts";
import type { FamilyStore, WriteLogRow } from "./store.ts";
import type { Config } from "./types.ts";
import { READ_ONLY, WRITES_OFF } from "./write-gate.ts";

const DONNIE_ID = "100000000000000001";
const BRITTA_ID = "100000000000000002";
const PENNY_ID = "100000000000000003";
const GOG = "/nonexistent/ocfp-test/gog";
const DONNIE_CAL = "donnie@example.com";

function household(writes: "on" | "confirm" | "off" = "on", members?: unknown[]): Config {
  return parseConfig({
    timezone: "America/Halifax",
    writes,
    members: members ?? [
      { profileId: "donnie", displayName: "Donnie", role: "parent", discordId: DONNIE_ID },
      { profileId: "britta", displayName: "Britta", role: "parent", discordId: BRITTA_ID },
      { profileId: "penny", displayName: "Penny", role: "kid", discordId: PENNY_ID },
    ],
    calendars: [
      { id: DONNIE_CAL, label: "Donnie", kind: "personal", owners: ["donnie"] },
      { id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: ["donnie", "britta", "penny"] },
      { id: "penny@example.com", label: "Penny", kind: "personal", owners: ["penny"] },
    ],
  });
}

type Created = { id: string; calendarId: string; summary: string; start: string; props: Record<string, string> };

/** A stand-in gog: lists by private-prop filter and creates. Nothing else answers, and no real gog is reachable. */
function fakeGog() {
  const events: Created[] = [];
  const calls: string[][] = [];
  /** Set to make the next `calendar create` fail the way execFile does: an error carrying gog's stderr and exit code. */
  const fail: { create?: { stderr: string; code: number } } = {};
  const flags = (args: string[]) => {
    const out = new Map<string, string[]>();
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (arg.startsWith("--") && eq > 0) out.set(arg.slice(0, eq), [...(out.get(arg.slice(0, eq)) ?? []), arg.slice(eq + 1)]);
    }
    return out;
  };
  const run: RunGog = async (file, args) => {
    assert.equal(file, GOG);
    calls.push(args);
    const f = flags(args);
    const id = args.at(-1) ?? "";
    if (args[0] === "calendar" && args[1] === "events") {
      const [name, value] = (f.get("--private-prop-filter")?.[0] ?? "=").split("=");
      const found = events.filter((event) => event.calendarId === id && event.props[name ?? ""] === value);
      return { stdout: JSON.stringify({ events: found.map((event) => ({ id: event.id, status: "confirmed", extendedProperties: { private: event.props } })) }) };
    }
    if (args[0] === "calendar" && args[1] === "create") {
      if (fail.create) {
        const { stderr, code } = fail.create;
        throw Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}\n${stderr}`), { stderr, code, stdout: "" });
      }
      const props: Record<string, string> = {};
      for (const prop of f.get("--private-prop") ?? []) props[prop.slice(0, prop.indexOf("="))] = prop.slice(prop.indexOf("=") + 1);
      const event = { id: `ev${events.length + 1}`, calendarId: id, summary: f.get("--summary")?.[0] ?? "", start: f.get("--from")?.[0] ?? "", props };
      events.push(event);
      return { stdout: JSON.stringify({ event: { id: event.id } }) };
    }
    throw new Error(`the stand-in gog has no ${args.slice(0, 2).join(" ")}`);
  };
  return { run, events, calls, fail, creates: () => calls.filter((args) => args[1] === "create").length };
}

/** The write log the family store keeps, in memory. */
function memoryLog() {
  const rows: WriteLogRow[] = [];
  return {
    rows,
    countCommittedWrites: async (base: string) => rows.filter((row) => row.baseKey === base && row.status === "committed").length,
    appendWriteLog: async (row: WriteLogRow) => {
      rows.push(row);
      return { inserted: true };
    },
  };
}

type Registered = { hookName: string; handler: (event: HookEvent, ctx: HookContext) => Promise<HookResult | undefined>; priority: number; matcher: readonly string[] };

function setup(options: { config?: Config; grant?: GrantHolder; log?: CalendarWriteDeps["log"] } = {}) {
  /** The object the hook and tool read, so a test can flip `writes` mid-approval. */
  const config: Config = { ...(options.config ?? household()), gogPath: GOG };
  const gog = fakeGog();
  const log = memoryLog();
  const grant = options.grant ?? grantHolder();
  const hooks: Registered[] = [];
  const tools: { factory: (ctx: ToolContext) => CalendarTool; name: string }[] = [];
  const api: CalendarWriteApi = {
    on: (hookName, handler, opts) => hooks.push({ hookName, handler, priority: opts.priority, matcher: opts.matcher }),
    registerTool: (factory, opts) => tools.push({ factory, name: opts.name }),
  };
  registerCalendarWrite(api, { config, runGog: gog.run, grant, log: options.log ?? (() => log) });
  return { config, gog, log, grant, hooks, tools };
}

type Setup = ReturnType<typeof setup>;
type Caller = { hook: HookContext; tool: ToolContext };

let sessionCounter = 0;
function discord(senderId: string, channel = "discord"): Caller {
  sessionCounter += 1;
  const sessionKey = `agent:main:discord:channel:${sessionCounter}`;
  return {
    hook: { toolName: CALENDAR_CREATE_TOOL, sessionKey, requester: { channel, senderId, senderIsOwner: false } },
    tool: { sessionKey, messageChannel: "discord", requesterSenderId: senderId, senderIsOwner: false },
  };
}
/**
 * WS tools.invoke (tools-invoke-CJUopToF.mjs:32-48): the hook gets the session key and no
 * requester; the tool gets no channel or sender, its owner flag is operator.admin, and its
 * conversationReadOrigin is "delegated" unless the caller asked for "direct-operator".
 */
function invoke(admin = false, origin: "delegated" | "direct-operator" = "delegated"): Caller {
  sessionCounter += 1;
  const sessionKey = `agent:main:invoke-${sessionCounter}`;
  return { hook: { toolName: CALENDAR_CREATE_TOOL, sessionKey }, tool: { sessionKey, senderIsOwner: admin, conversationReadOrigin: origin } };
}
/**
 * HTTP /tools/invoke (tools-invoke-http-DsV9C_z1.mjs:52-56, 78-93): the caller's
 * x-openclaw-message-channel header becomes the tool's messageChannel and x-openclaw-account-id its
 * agentAccountId; the body picks the session key; the host marks the call "direct-operator" and
 * sets no requesterSenderId. The hook gets the session key and no requester.
 */
function httpInvoke(headers: { channel?: string; account?: string }, sessionKey: string, owner = true): Caller {
  const tool = { sessionKey, senderIsOwner: owner, conversationReadOrigin: "direct-operator" as const, messageChannel: headers.channel, agentAccountId: headers.account };
  return { hook: { toolName: CALENDAR_CREATE_TOOL, sessionKey }, tool: tool as ToolContext };
}

/**
 * The agent RPC with `channel: "discord"` (src-BvzgK7Oj.mjs:2946, agent-turn-service-Gu0_gTsb.mjs
 * :1545-1553): the run's channel is the caller's, and nothing on that path sets a sender, so the
 * hook's requester has the channel and no senderId and the tool has messageChannel and no
 * requesterSenderId. The session key is the caller's too.
 */
function agentRpc(owner: boolean): Caller {
  sessionCounter += 1;
  const sessionKey = `agent:main:discord:channel:${DONNIE_ID}-${sessionCounter}`;
  return {
    hook: { toolName: CALENDAR_CREATE_TOOL, sessionKey, requester: { channel: "discord", senderIsOwner: owner } },
    tool: { sessionKey, messageChannel: "discord", senderIsOwner: owner },
  };
}

const SLEEPOVER = { calendar: "Donnie", title: "Sleepover", start: "2026-10-09T16:30:00-03:00", end: "2026-10-10T09:00:00-03:00" };
const TITLE = "Penny wants to add **Sleepover** to Donnie's calendar";
const DESCRIPTION = "Penny asked on Discord. Sleepover, Friday October 9 at 4:30 PM, on Donnie's calendar.";
const CREATED = "Added **Sleepover** to Donnie's calendar, Friday October 9 at 4:30 PM.";
const NOT_APPROVED = "That didn't get approved, so I didn't add **Sleepover**. Ask again when Donnie or Britta is around.";
const TIMED_OUT = "Nobody answered in 10 minutes, so I didn't add **Sleepover**. Ask again when Donnie or Britta is around.";
const WRONG = "Something went wrong checking that, so I didn't add **Sleepover**.";

type OtherHook = { priority: number; handler: (event: HookEvent) => HookResult | undefined };
type Outcome = { blocked?: string; text?: string; approval?: NonNullable<HookResult["requireApproval"]>; toolParams?: Record<string, unknown> };

/**
 * The host's path for one tool call, as openclaw c074824 runs it: hooks highest priority first,
 * each handed its own copy of the original params (hooks-DMax5We2.mjs runBeforeToolCall); params
 * merge as `next ?? acc` until a hook asks for approval, then freeze; the tool runs with the
 * original params plus the hook's (agent-tools.before-tool-call mergeParamsWithApprovalOverrides),
 * and only after allow-once.
 */
async function hostCall(s: Setup, caller: Caller, params: Record<string, unknown>, options: { decide?: (approval: NonNullable<HookResult["requireApproval"]>) => Promise<ApprovalResolution> | ApprovalResolution; others?: OtherHook[] } = {}): Promise<Outcome> {
  const ours = s.hooks.map((hook) => ({ priority: hook.priority, handler: (event: HookEvent) => hook.handler(event, caller.hook) }));
  const all = [...ours, ...(options.others ?? []).map((other) => ({ priority: other.priority, handler: async (event: HookEvent) => other.handler(event) }))].sort((a, b) => b.priority - a.priority);
  let acc: HookResult | undefined;
  for (const hook of all) {
    const next = await hook.handler(structuredClone({ toolName: CALENDAR_CREATE_TOOL, params }));
    if (next === undefined) continue;
    const frozen = acc?.requireApproval !== undefined;
    const merged: HookResult = { block: acc?.block === true || next.block === true };
    const mergedParams = frozen ? acc?.params : (next.params ?? acc?.params);
    if (mergedParams) merged.params = mergedParams;
    const reason = next.blockReason ?? acc?.blockReason;
    if (reason !== undefined) merged.blockReason = reason;
    const approval = acc?.requireApproval ?? next.requireApproval;
    if (approval) merged.requireApproval = approval;
    acc = merged;
    if (acc.block) break;
  }
  if (acc?.block) return { blocked: acc.blockReason ?? "blocked" };
  const outcome: Outcome = {};
  if (acc?.requireApproval) {
    outcome.approval = acc.requireApproval;
    const decision = options.decide ? await options.decide(acc.requireApproval) : "allow-once";
    await acc.requireApproval.onResolution(decision);
    if (decision === "timeout") return { ...outcome, blocked: acc.requireApproval.timeoutReason };
    if (decision !== "allow-once") return { ...outcome, blocked: `host:${decision}` };
  }
  const toolParams = acc?.params ? { ...params, ...acc.params } : params;
  const tool = s.tools[0]!.factory(caller.tool);
  const result = await tool.execute("call-1", toolParams);
  return { ...outcome, toolParams, text: result.content[0]!.text };
}

const statuses = (s: Setup) => s.log.rows.map((row) => row.status);

// ---- Registration ----

test("registerCalendarWrite registers the before_tool_call hook at the highest priority together with calendar_create", () => {
  const s = setup();
  assert.equal(s.hooks.length, 1);
  assert.equal(s.hooks[0]!.hookName, "before_tool_call");
  assert.equal(s.hooks[0]!.priority, CALENDAR_HOOK_PRIORITY);
  assert.deepEqual(s.hooks[0]!.matcher, [CALENDAR_CREATE_TOOL]);
  assert.deepEqual(s.tools.map((tool) => tool.name), [CALENDAR_CREATE_TOOL]);
  assert.ok(Number.isFinite(CALENDAR_HOOK_PRIORITY) && CALENDAR_HOOK_PRIORITY >= 1_000_000_000, "the hook must run first");
});

test("the tool schema the model sees has no stamp and no series scope", () => {
  const properties = Object.keys(CalendarCreateInputSchema.properties);
  assert.deepEqual(properties.sort(), ["allDay", "calendar", "description", "end", "location", "start", "title"]);
  const s = setup();
  const tool = s.tools[0]!.factory(discord(PENNY_ID).tool);
  assert.ok(!JSON.stringify(tool.parameters).includes(STAMP_PARAM));
  assert.ok(!/series|scope/i.test(JSON.stringify(tool.parameters)));
});

// ---- One key, from either side ----

test("the hook and the tool derive the same key on the agent-run path and on tools.invoke", () => {
  const config = household();
  for (const caller of [discord(PENNY_ID), discord(DONNIE_ID), discord("199999999999999999"), discord(PENNY_ID, "Discord")]) {
    assert.equal(deriveBaseKey(config, factsFromHook(caller.hook), SLEEPOVER), deriveBaseKey(config, factsFromTool(caller.tool), SLEEPOVER));
  }
  for (const admin of [false, true]) {
    const caller = invoke(admin);
    assert.equal(deriveBaseKey(config, factsFromHook(caller.hook), SLEEPOVER), deriveBaseKey(config, factsFromTool(caller.tool), SLEEPOVER), `admin ${admin}`);
  }
  // Off Discord the owner flag doesn't change the key: every off-Discord caller is `tool`.
  const sessionKey = "agent:main:webchat";
  const owner = deriveBaseKey(config, { sessionKey, channel: "webchat", senderIsOwner: true }, SLEEPOVER);
  assert.equal(owner, deriveBaseKey(config, { sessionKey, channel: "webchat", senderIsOwner: false }, SLEEPOVER));
  assert.equal(owner, deriveBaseKey(config, { sessionKey }, SLEEPOVER));
  // A differently-cased channel still finds the roster person.
  assert.equal(deriveBaseKey(config, { sessionKey, channel: "DISCORD", senderId: PENNY_ID }, SLEEPOVER), deriveBaseKey(config, { sessionKey, channel: "discord", senderId: PENNY_ID }, SLEEPOVER));
  assert.notEqual(deriveBaseKey(config, { sessionKey, channel: "discord", senderId: PENNY_ID }, SLEEPOVER), owner);
});

test("the key is the one the write log stores for the committed write", async () => {
  const s = setup();
  const caller = discord(PENNY_ID);
  const outcome = await hostCall(s, caller, SLEEPOVER);
  assert.equal(outcome.text, CREATED);
  assert.deepEqual(statuses(s), ["committed"]);
  assert.equal(s.log.rows[0]!.baseKey, deriveBaseKey(s.config, factsFromTool(caller.tool), SLEEPOVER));
  assert.equal(s.log.rows[0]!.requester, "discord:penny");
});

// ---- A kid's write waits for a parent ----

test("a kid's add to a parent's calendar asks for approval with ux's title and description, the 10-minute timeout, and allow-once or deny only", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, {
    decide: (approval) => {
      assert.equal(s.gog.calls.length, 0, "nothing reaches gog before the decision");
      assert.deepEqual(s.log.rows, [], "no row before the decision");
      assert.equal(approval.title, TITLE);
      assert.equal(approval.description, DESCRIPTION);
      assert.equal(approval.timeoutMs, APPROVAL_TIMEOUT_MS);
      assert.equal(APPROVAL_TIMEOUT_MS, 600_000);
      assert.equal(approval.timeoutReason, TIMED_OUT);
      assert.deepEqual(approval.allowedDecisions, ["allow-once", "deny"]);
      return "allow-once";
    },
  });
  assert.equal(outcome.text, CREATED);
  assert.equal(s.gog.creates(), 1);
  assert.deepEqual(statuses(s), ["committed"]);
});

test("allow-once writes once through the normal path, with no table run after the approval", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "allow-once" });
  assert.equal(outcome.text, CREATED);
  assert.ok(!/approv/i.test(outcome.text ?? ""), "the created line says nothing about approval");
  assert.equal(s.gog.events.length, 1);
  assert.equal(s.gog.events[0]!.summary, "Sleepover");
  assert.equal(s.log.rows[0]!.eventId, "ev1");
});

test("an explicit deny writes one `denied` row with no event id and never reaches gog", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "deny" });
  assert.equal(outcome.blocked, "host:deny");
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["denied"]);
  assert.equal(s.log.rows[0]!.eventId, undefined);
  assert.equal(s.log.rows[0]!.calendarId, DONNIE_CAL);
});

test("our timeout writes `timed-out` and the tool result is our timed-out line, its minutes read from the constant", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "timeout" });
  assert.equal(outcome.blocked, TIMED_OUT);
  assert.ok(TIMED_OUT.includes(`${APPROVAL_TIMEOUT_MS / 60_000} minutes`));
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["timed-out"]);
});

test("the host's cancelled (no route, approvalMode report, run abort) writes `failed`, and approvalMode deny writes `denied`", async () => {
  const cancelled = setup();
  await hostCall(cancelled, discord(PENNY_ID), SLEEPOVER, { decide: () => "cancelled" });
  assert.deepEqual(statuses(cancelled), ["failed"]);
  assert.equal(cancelled.gog.calls.length, 0);
  const policyDeny = setup();
  await hostCall(policyDeny, invoke(), SLEEPOVER, { decide: () => "deny" });
  assert.deepEqual(statuses(policyDeny), ["denied"]);
  assert.equal(policyDeny.gog.calls.length, 0);
});

test("the outcome statuses pass the write log's CHECK in the real store", async () => {
  const { openFamilyStore } = (await import(new URL("../dist/store.js", import.meta.url).href)) as { openFamilyStore: (o: { stateDir: string }) => Promise<FamilyStore> };
  const stateDir = mkdtempSync(join(tmpdir(), "ocfp-create-state-"));
  const store = await openFamilyStore({ stateDir });
  try {
    for (const decision of ["deny", "timeout", "cancelled"] as const) {
      const s = setup({ log: () => store });
      await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => decision });
    }
    const s = setup({ log: () => store });
    assert.equal((await hostCall(s, discord(PENNY_ID), SLEEPOVER)).text, CREATED);
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the approval payload names people only: no calendar id, event id, key, requester tag, session key or stamp", async () => {
  const s = setup();
  const caller = discord(PENNY_ID);
  let payload = "";
  await hostCall(s, caller, SLEEPOVER, {
    decide: (approval) => {
      const { onResolution: _onResolution, ...rest } = approval;
      payload = JSON.stringify(rest);
      return "allow-once";
    },
  });
  const base = deriveBaseKey(s.config, factsFromTool(caller.tool), SLEEPOVER);
  for (const secret of [DONNIE_CAL, "family@group", base, base.slice(0, 16), "discord:", PENNY_ID, caller.hook.sessionKey!, "ev1", STAMP_PARAM, "ocfp"]) {
    assert.ok(!payload.includes(secret), `payload leaks ${secret}`);
  }
});

test("a long event name is cut with … to fit 80; the person's name and the calendar stay whole; the description fits 512", async () => {
  const s = setup();
  const long = { ...SLEEPOVER, title: `Sleepover ${"and pizza ".repeat(60)}` };
  const outcome = await hostCall(s, discord(PENNY_ID), long, { decide: () => "deny" });
  const approval = outcome.approval!;
  assert.ok([...approval.title].length <= APPROVAL_TITLE_MAX, approval.title);
  assert.ok(approval.title.startsWith("Penny wants to add **Sleepover and pizza"));
  assert.ok(approval.title.endsWith("…** to Donnie's calendar"));
  assert.ok([...approval.description].length <= APPROVAL_DESCRIPTION_MAX);
  assert.ok(approval.description.startsWith("Penny asked on Discord. Sleepover and pizza"));
  assert.ok(approval.description.endsWith("…, Friday October 9 at 4:30 PM, on Donnie's calendar."));
});

test("a long person's name is never cut; the event name gives way", async () => {
  const config = household("on", [
    { profileId: "donnie", displayName: "Donnie", role: "parent" },
    { profileId: "britta", displayName: "Britta", role: "parent" },
    { profileId: "penny", displayName: "Penelope Josephine Fiander-Smith", role: "kid", discordId: PENNY_ID },
  ]);
  const s = setup({ config });
  const outcome = await hostCall(s, discord(PENNY_ID), { ...SLEEPOVER, title: "A very long sleepover at the cottage with everyone" }, { decide: () => "deny" });
  const title = outcome.approval!.title;
  assert.ok([...title].length <= APPROVAL_TITLE_MAX, title);
  assert.ok(title.startsWith("Penelope Josephine Fiander-Smith wants to add **A very"));
  assert.ok(title.includes("…**"));
});

test("an all-day add reads like Bernie without a time", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), { calendar: "Donnie", title: "Sleepover", start: "2026-10-09", allDay: true });
  assert.equal(outcome.approval!.description, "Penny asked on Discord. Sleepover, Friday October 9, on Donnie's calendar.");
  assert.equal(outcome.text, "Added **Sleepover** to Donnie's calendar, Friday October 9.");
});

test("tools.invoke has no requester: Someone, and 'Asked outside Discord.'; never an id, a session key, or tool:owner", async () => {
  for (const admin of [false, true]) {
    const s = setup();
    const caller = invoke(admin);
    const outcome = await hostCall(s, caller, SLEEPOVER, { decide: () => "deny" });
    assert.equal(outcome.approval!.title, "Someone wants to add **Sleepover** to Donnie's calendar");
    assert.equal(outcome.approval!.description, "Asked outside Discord. Sleepover, Friday October 9 at 4:30 PM, on Donnie's calendar.");
    const text = JSON.stringify([outcome.approval!.title, outcome.approval!.description]);
    assert.ok(!text.includes(caller.hook.sessionKey!) && !text.includes("tool:owner") && !text.includes("tool"));
    assert.equal(s.log.rows[0]!.requester, "tool");
  }
});

test("HTTP /tools/invoke with a discord channel header and Donnie's id everywhere a caller can put it is `tool`: one key, approval first, then one write", async () => {
  // The header set (tools-invoke-http-DsV9C_z1.mjs:52-55) has no sender header, so Donnie's id
  // goes in the account header, a Discord-shaped session key in the body, and claims in the args.
  const s = setup();
  sessionCounter += 1;
  const caller = httpInvoke({ channel: "discord", account: DONNIE_ID }, `agent:main:discord:channel:${DONNIE_ID}-${sessionCounter}`);
  const claims = { ...SLEEPOVER, channel: "discord", senderId: DONNIE_ID, requesterSenderId: DONNIE_ID, senderIsOwner: true };
  const hookKey = deriveBaseKey(s.config, factsFromHook(caller.hook), claims);
  assert.equal(deriveBaseKey(s.config, factsFromTool(caller.tool), claims), hookKey);
  let atDecision: { gog: number; rows: number } | undefined;
  const outcome = await hostCall(s, caller, claims, {
    decide: () => {
      atDecision = { gog: s.gog.calls.length, rows: s.log.rows.length };
      return "allow-once";
    },
  });
  assert.deepEqual(atDecision, { gog: 0, rows: 0 });
  assert.equal(outcome.approval!.title, "Someone wants to add **Sleepover** to Donnie's calendar");
  assert.equal(outcome.approval!.description, "Asked outside Discord. Sleepover, Friday October 9 at 4:30 PM, on Donnie's calendar.");
  assert.equal(outcome.text, CREATED);
  assert.equal(s.gog.creates(), 1);
  assert.deepEqual(statuses(s), ["committed"]);
  assert.equal(s.log.rows[0]!.requester, "tool");
  assert.equal(s.log.rows[0]!.baseKey, hookKey);
  assert.ok(!JSON.stringify(s.log.rows).includes("discord:"), "no row is tagged discord:*");
});

test("an agent-RPC call with channel discord and no host sender is `tool` on both sides: one key, approval first, never a discord:* row", async () => {
  for (const owner of [false, true]) {
    const s = setup();
    const caller = agentRpc(owner);
    const hookKey = deriveBaseKey(s.config, factsFromHook(caller.hook), SLEEPOVER);
    assert.equal(deriveBaseKey(s.config, factsFromTool(caller.tool), SLEEPOVER), hookKey);
    assert.equal(hookKey, deriveBaseKey(s.config, { sessionKey: caller.hook.sessionKey }, SLEEPOVER), "the same key as any off-Discord call");
    const outcome = await hostCall(s, caller, SLEEPOVER);
    assert.equal(outcome.approval!.title, "Someone wants to add **Sleepover** to Donnie's calendar");
    assert.equal(outcome.text, CREATED);
    assert.deepEqual(statuses(s), ["committed"]);
    assert.equal(s.log.rows[0]!.requester, "tool");
    assert.equal(s.log.rows[0]!.baseKey, hookKey);
    assert.ok(!JSON.stringify(s.log.rows).includes("discord:"), "no row is tagged discord:*");
  }
});

test("WS tools.invoke is `tool` whether or not the caller asks for direct-operator, owner or not", async () => {
  for (const origin of ["delegated", "direct-operator"] as const) {
    for (const admin of [false, true]) {
      const s = setup();
      const caller = invoke(admin, origin);
      assert.equal(deriveBaseKey(s.config, factsFromTool(caller.tool), SLEEPOVER), deriveBaseKey(s.config, factsFromHook(caller.hook), SLEEPOVER));
      const outcome = await hostCall(s, caller, SLEEPOVER);
      assert.equal(outcome.approval!.title, "Someone wants to add **Sleepover** to Donnie's calendar");
      assert.equal(outcome.text, CREATED);
      assert.deepEqual(statuses(s), ["committed"]);
      assert.equal(s.log.rows[0]!.requester, "tool");
    }
  }
});

// ---- The model's text for deny and cancel ----

test("the tool description carries the shared not-approved line with the approvers mid-sentence and tells the model to drop host text", () => {
  const s = setup();
  const description = s.tools[0]!.factory(discord(PENNY_ID).tool).description;
  assert.ok(description.includes(`"${NOT_APPROVED.replace("Sleepover", "<event name>")}"`), description);
  assert.ok(description.includes("Never pass on the host's own text, IDs, or /approve."));
  assert.ok(description.includes("Calendars: Donnie, Family, Penny."));
  const three = setup({
    config: household("on", [
      { profileId: "a", displayName: "Ann", role: "parent" },
      { profileId: "b", displayName: "Bob", role: "parent" },
      { profileId: "c", displayName: "Cy", role: "parent" },
      { profileId: "donnie", displayName: "Donnie", role: "kid" },
      { profileId: "britta", displayName: "Britta", role: "kid" },
      { profileId: "penny", displayName: "Penny", role: "kid" },
    ]),
  });
  assert.ok(three.tools[0]!.factory(invoke().tool).description.includes("Ask again when Ann, Bob, or Cy is around."));
});

test("with no parents the approver is the person who set this up", async () => {
  const config = household("on", [
    { profileId: "donnie", displayName: "Donnie", role: "kid" },
    { profileId: "britta", displayName: "Britta", role: "kid" },
    { profileId: "penny", displayName: "Penny", role: "kid", discordId: PENNY_ID },
  ]);
  const s = setup({ config });
  assert.ok(s.tools[0]!.factory(invoke().tool).description.includes("Ask again when the person who set this up is around."));
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "timeout" });
  assert.equal(outcome.blocked, "Nobody answered in 10 minutes, so I didn't add **Sleepover**. Ask again when the person who set this up is around.");
});

// ---- Who needs approval ----

test("a parent writes without approval when writes are on, and a kid writes to their own calendar without one", async () => {
  const parent = setup();
  const p = await hostCall(parent, discord(DONNIE_ID), SLEEPOVER, { decide: () => assert.fail("no approval for a parent") });
  assert.equal(p.text, CREATED);
  const kid = setup();
  const k = await hostCall(kid, discord(PENNY_ID), { ...SLEEPOVER, calendar: "Penny" }, { decide: () => assert.fail("no approval on her own calendar") });
  assert.equal(k.text, "Added **Sleepover** to Penny's calendar, Friday October 9 at 4:30 PM.");
});

test("writes confirm sends a parent's call for approval too", async () => {
  const s = setup({ config: household("confirm") });
  let asked = false;
  const outcome = await hostCall(s, discord(DONNIE_ID), SLEEPOVER, {
    decide: (approval) => {
      asked = true;
      assert.equal(approval.title, "Donnie wants to add **Sleepover** to Donnie's calendar");
      return "deny";
    },
  });
  assert.ok(asked);
  assert.equal(outcome.blocked, "host:deny");
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["denied"]);
});

test("no tool parameter changes the decision: claims of role, table, approval or sender are ignored", async () => {
  const claims = {
    ...SLEEPOVER,
    table: "write",
    decision: "write",
    approved: true,
    role: "parent",
    requester: "discord:donnie",
    senderId: DONNIE_ID,
    senderIsOwner: true,
    scope: "elsewhere",
    writes: "on",
  };
  const s = setup();
  const caller = discord(PENNY_ID);
  assert.equal(deriveBaseKey(s.config, factsFromHook(caller.hook), claims), deriveBaseKey(s.config, factsFromHook(caller.hook), SLEEPOVER));
  const outcome = await hostCall(s, caller, claims, { decide: () => "deny" });
  assert.equal(outcome.approval!.title, TITLE);
  assert.equal(s.gog.calls.length, 0);
  // Straight to the tool, with every claim and no stamp: refused.
  const direct = await s.tools[0]!.factory(discord(PENNY_ID).tool).execute("call-x", claims);
  assert.equal(direct.content[0]!.text, WRONG);
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["denied", "failed"]);
});

// ---- The stamp ----

test("a hook that returns nothing for a kid leaves no stamp, so the tool refuses with ux's line, logs failed, and never calls gog", async () => {
  const s = setup();
  const caller = discord(PENNY_ID);
  const result = await s.tools[0]!.factory(caller.tool).execute("call-1", SLEEPOVER);
  assert.equal(result.content[0]!.text, WRONG);
  assert.ok(!/approv|Donnie|Britta|stamp|key|param/i.test(WRONG));
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["failed"]);
  assert.equal(s.log.rows[0]!.eventId, undefined);
});

test("a forged, too-short, too-long, non-string or non-hex stamp lands on the something-went-wrong line, logged failed, no gog, no throw", async () => {
  const s = setup();
  const caller = discord(PENNY_ID);
  const tool = s.tools[0]!.factory(caller.tool);
  const real = await s.hooks[0]!.handler({ toolName: CALENDAR_CREATE_TOOL, params: SLEEPOVER }, caller.hook);
  const good = String(real!.params![STAMP_PARAM]);
  assert.equal(good.length, 64);
  const forged: unknown[] = [
    crypto.randomBytes(32).toString("hex"),
    good.slice(0, 10),
    good.slice(0, 63),
    `${good}0`,
    `${good}${good}`,
    "",
    "z".repeat(64),
    "é".repeat(32),
    12345,
    null,
    true,
    { stamp: good },
    [good],
  ];
  for (const value of forged) {
    const result = await tool.execute("call-f", { ...SLEEPOVER, [STAMP_PARAM]: value });
    assert.equal(result.content[0]!.text, WRONG, `stamp ${JSON.stringify(value)}`);
  }
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), forged.map(() => "failed"));
});

test("a stamp from another plugin instance is refused: every registration makes its own secret", async () => {
  const a = setup();
  const b = setup();
  const caller = discord(DONNIE_ID);
  const fromA = await a.hooks[0]!.handler({ toolName: CALENDAR_CREATE_TOOL, params: SLEEPOVER }, caller.hook);
  const fromB = await b.hooks[0]!.handler({ toolName: CALENDAR_CREATE_TOOL, params: SLEEPOVER }, caller.hook);
  assert.notEqual(fromA!.params![STAMP_PARAM], fromB!.params![STAMP_PARAM]);
  const result = await b.tools[0]!.factory(caller.tool).execute("call-1", { ...SLEEPOVER, ...fromA!.params });
  assert.equal(result.content[0]!.text, WRONG);
  assert.equal(b.gog.calls.length, 0);
  assert.equal((await a.tools[0]!.factory(caller.tool).execute("call-1", { ...SLEEPOVER, ...fromA!.params })).content[0]!.text, CREATED);
});

test("the stamp binds the decision and the tool name, and is compared with timingSafeEqual after a length check", () => {
  const stamper = createStamper();
  const base = "a".repeat(64);
  assert.equal(stamper.verify(stamper.stamp(base, "approved", CALENDAR_CREATE_TOOL), base, CALENDAR_CREATE_TOOL), "approved");
  assert.equal(stamper.verify(stamper.stamp(base, "write", CALENDAR_CREATE_TOOL), base, CALENDAR_CREATE_TOOL), "write");
  assert.notEqual(stamper.stamp(base, "write", CALENDAR_CREATE_TOOL), stamper.stamp(base, "approved", CALENDAR_CREATE_TOOL));
  assert.equal(stamper.verify(stamper.stamp(base, "write", "calendar_update"), base, CALENDAR_CREATE_TOOL), undefined);
  assert.equal(stamper.verify(stamper.stamp(base, "write", CALENDAR_CREATE_TOOL), "b".repeat(64), CALENDAR_CREATE_TOOL), undefined);
  const spy = mock.method(crypto, "timingSafeEqual");
  try {
    assert.equal(stamper.verify(stamper.stamp(base, "write", CALENDAR_CREATE_TOOL), base, CALENDAR_CREATE_TOOL), "write");
    assert.ok(spy.mock.callCount() >= 1, "a match goes through timingSafeEqual");
    const before = spy.mock.callCount();
    assert.doesNotThrow(() => assert.equal(stamper.verify("ab", base, CALENDAR_CREATE_TOOL), undefined));
    assert.equal(spy.mock.callCount(), before, "a wrong length never reaches timingSafeEqual");
  } finally {
    spy.mock.restore();
  }
});

test("the hook overwrites a model-supplied stamp, and the forged value shows up nowhere: approval, reply, log or event props", async () => {
  const s = setup();
  const forged = "FORGED-stamp-value-0123456789";
  const outcome = await hostCall(s, discord(PENNY_ID), { ...SLEEPOVER, [STAMP_PARAM]: forged }, { decide: () => "allow-once" });
  assert.equal(outcome.text, CREATED);
  assert.notEqual(outcome.toolParams![STAMP_PARAM], forged);
  const real = String(outcome.toolParams![STAMP_PARAM]);
  const { onResolution: _onResolution, ...approval } = outcome.approval!;
  const seen = JSON.stringify([approval, outcome.text, s.log.rows.map((row) => [row.beforeJson, row.afterJson, row.requestKey, row.baseKey])]);
  for (const value of [forged, real, STAMP_PARAM]) assert.ok(!seen.includes(value), `${value === real ? "the real stamp" : value} leaked`);
  assert.deepEqual(Object.keys(s.gog.events[0]!.props).sort(), ["ocfpBase", "ocfpKey"]);
  assert.ok(!s.gog.calls.flat().some((arg) => arg.includes(forged) || arg.includes(real)), "no stamp reaches gog");
});

test("a parent's write with no approval drops a model-supplied stamp before the key: the clean key, a normal write, and the forged value nowhere", async () => {
  const s = setup();
  const forged = "FORGED-stamp-value-0123456789";
  const caller = discord(DONNIE_ID);
  const outcome = await hostCall(s, caller, { ...SLEEPOVER, [STAMP_PARAM]: forged }, { decide: () => assert.fail("a parent with writes on needs no approval") });
  assert.equal(outcome.approval, undefined);
  assert.equal(outcome.text, CREATED);
  assert.deepEqual(statuses(s), ["committed"]);
  assert.equal(s.log.rows[0]!.baseKey, deriveBaseKey(s.config, factsFromTool(caller.tool), SLEEPOVER));
  assert.equal(s.log.rows[0]!.requester, "discord:donnie");
  assert.notEqual(outcome.toolParams![STAMP_PARAM], forged);
  const seen = JSON.stringify([outcome.text, s.log.rows, s.gog.events.map((event) => event.props)]);
  assert.ok(!seen.includes(forged), "the forged stamp leaked");
  assert.deepEqual(Object.keys(s.gog.events[0]!.props).sort(), ["ocfpBase", "ocfpKey"]);
  assert.ok(!s.gog.calls.flat().some((arg) => arg.includes(forged)), "no forged stamp reaches gog");
});

test("a parent's write a lower-priority hook rewrites is refused with ux's line and logged failed, with no gog call", async () => {
  const s = setup();
  const rewriter: OtherHook = { priority: 0, handler: (event) => ({ params: { ...event.params, title: "REWRITTEN" } }) };
  const outcome = await hostCall(s, discord(DONNIE_ID), SLEEPOVER, { others: [rewriter] });
  assert.equal(outcome.toolParams!.title, "REWRITTEN");
  assert.equal(outcome.text, "Something went wrong checking that, so I didn't add **REWRITTEN**.");
  assert.equal(s.gog.calls.length, 0);
  assert.deepEqual(statuses(s), ["failed"]);
  // Even holding our own stamp, a changed field is a different key.
  const caller = discord(DONNIE_ID);
  const stamped = await s.hooks[0]!.handler({ toolName: CALENDAR_CREATE_TOOL, params: SLEEPOVER }, caller.hook);
  const moved = await s.tools[0]!.factory(caller.tool).execute("call-2", { ...stamped!.params, start: "2026-10-09T17:30:00-03:00" });
  assert.equal(moved.content[0]!.text, WRONG);
  assert.equal(s.gog.calls.length, 0);
});

test("once our hook asks for approval, a lower-priority rewrite is dropped and the approved call is what runs", async () => {
  const s = setup();
  const rewriter: OtherHook = { priority: 0, handler: (event) => ({ params: { ...event.params, title: "REWRITTEN" } }) };
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, { others: [rewriter], decide: () => "allow-once" });
  assert.equal(outcome.approval!.title, TITLE);
  assert.equal(outcome.text, CREATED);
  assert.equal(s.gog.events[0]!.summary, "Sleepover");
});

test("registering and using the hook and tool prints nothing that looks like a secret", async () => {
  const printed: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => mock.method(console, name, (...args: unknown[]) => printed.push(args.map(String).join(" "))));
  try {
    const s = setup();
    await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "allow-once" });
    await hostCall(s, discord(PENNY_ID), SLEEPOVER, { decide: () => "deny" });
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
  assert.ok(!printed.some((line) => /[0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2}/.test(line)), printed.join("\n"));
});

// ---- Checks again after the approval ----

test("writes turned off while an approval is pending: approving it is refused with the off line, no gog call and no committed row", async () => {
  const s = setup();
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, {
    decide: () => {
      s.config.writes = "off";
      return "allow-once";
    },
  });
  assert.equal(outcome.text, WRITES_OFF);
  assert.equal(s.gog.calls.length, 0);
  assert.ok(!s.log.rows.some((row) => row.status === "committed"));
});

test("a grant that turns read-only while an approval is pending: approving it is refused with the read-only line, no gog call and no committed row", async () => {
  const grant = grantHolder();
  const s = setup({ grant });
  const outcome = await hostCall(s, discord(PENNY_ID), SLEEPOVER, {
    decide: () => {
      grant.noteWriteFailure(Object.assign(new Error("Command failed"), { stderr: "Error 403: Request had insufficient authentication scopes." }));
      return "allow-once";
    },
  });
  assert.equal(outcome.text, READ_ONLY);
  assert.equal(s.gog.calls.length, 0);
  assert.ok(!s.log.rows.some((row) => row.status === "committed"));
});

test("writes off and a read-only grant refuse in the hook before any approval, with no row", async () => {
  const off = setup({ config: household("off") });
  assert.deepEqual(await hostCall(off, discord(PENNY_ID), SLEEPOVER, { decide: () => assert.fail("no approval when writes are off") }), { blocked: WRITES_OFF });
  const readOnly = setup({ grant: grantHolder("read-only") });
  assert.deepEqual(await hostCall(readOnly, discord(DONNIE_ID), SLEEPOVER), { blocked: READ_ONLY });
  assert.deepEqual([...off.log.rows, ...readOnly.log.rows], []);
  assert.equal(off.gog.calls.length + readOnly.gog.calls.length, 0);
});

// ---- gog fails at write time ----

test("gog fails at write time: read-only flips the grant and says so; anything else is the couldn't-reach line, leaves the grant, and never throws or shows gog's text", async () => {
  const UNREACHABLE = "I couldn't reach the calendar just now, so I didn't add **Sleepover**. Try again in a bit.";
  assert.equal(READ_ONLY, "I can only read the calendars right now, so I didn't change anything.");
  // Read-only: gog's grant error flips the shared grant; the next call stops in the hook before gog.
  const grant = grantHolder("read-write");
  const s = setup({ grant });
  s.gog.fail.create = { stderr: "Google API error (403 insufficientPermissions): Request had insufficient authentication scopes.", code: 1 };
  const first = await hostCall(s, discord(DONNIE_ID), SLEEPOVER);
  assert.equal(first.text, READ_ONLY);
  assert.deepEqual(statuses(s), ["failed"]);
  assert.equal(grant.get(), "read-only");
  assert.equal(grant.source(), "write-failure");
  delete s.gog.fail.create;
  const gogBefore = s.gog.calls.length;
  assert.deepEqual(await hostCall(s, discord(DONNIE_ID), SLEEPOVER), { blocked: READ_ONLY });
  assert.equal(s.gog.calls.length - gogBefore, 0, "the next call never reaches gog");
  assert.deepEqual(statuses(s), ["failed"]);
  // The next read-write poll clears it.
  const fullScope: RunGog = async () => ({ stdout: JSON.stringify({ accounts: [{ email: DONNIE_CAL, services: ["calendar"], scopes: ["https://www.googleapis.com/auth/calendar"] }] }) });
  await grant.refresh(fullScope, GOG);
  assert.equal(grant.get(), "read-write");
  assert.equal(grant.source(), "poll");

  // Any other failure: a canary on gog's stderr and a non-zero exit, no read-only match.
  const CANARY = "CANARY-gog-stderr-7f3a9c";
  const other = setup({ grant: grantHolder("read-write") });
  other.gog.fail.create = { stderr: `${CANARY}: dial tcp: lookup www.googleapis.com: no such host`, code: 2 };
  const failed = await hostCall(other, discord(DONNIE_ID), SLEEPOVER);
  assert.equal(failed.text, UNREACHABLE);
  assert.ok(!failed.text!.includes(CANARY));
  assert.ok(!failed.text!.includes("tool execution failed"));
  assert.deepEqual(statuses(other), ["failed"]);
  assert.equal(other.grant.get(), "read-write", "the grant is left alone");
  assert.equal(other.grant.source(), "initial");
});

test("other tools pass through the hook untouched", async () => {
  const s = setup();
  assert.equal(await s.hooks[0]!.handler({ toolName: "family_schedule", params: { [STAMP_PARAM]: "x" } }, discord(PENNY_ID).hook), undefined);
});
