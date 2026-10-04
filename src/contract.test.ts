import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import plugin from "./index.ts";
import { CALENDAR_HOOK_PRIORITY } from "./calendar-create.ts";
import {
  CALENDAR_CHANGED_EVENT,
  CALENDAR_CHECKED_EVENT,
  CalendarChangedSchema,
  CalendarCheckedSchema,
  CalendarWriteResultSchema,
  CalendarWriteSchema,
  FEATURE_EVENT_ID_PATTERN,
  TodayPayloadSchema,
  contract,
} from "./contract.ts";
import type { CalendarWrite } from "./types.ts";

type Assert<T extends true> = T;
type OpOf<T> = T extends { op: infer Op } ? Op : never;
type _CalendarWriteOps = Assert<
  OpOf<CalendarWrite> extends "create" | "update" | "move" | "delete"
    ? "create" | "update" | "move" | "delete" extends OpOf<CalendarWrite>
      ? true
      : false
    : false
>;

test("the contract registers the three read queries and the page's one write action, and the week is not one", () => {
  assert.deepEqual(
    Object.entries(contract.operations).map(([name, operation]) => [name, operation.kind]),
    [
      ["family.members", "query"],
      ["family.weather", "query"],
      ["family.schedule", "query"],
      ["family.calendar.write", "action"],
    ],
  );
  assert.deepEqual(
    Object.entries(contract.operations).flatMap(([name, operation]) => ("tool" in operation ? [[name, operation.tool]] : [])),
    [["family.schedule", { name: "family_schedule", label: "Family schedule" }]],
  );
  assert.deepEqual(Object.keys(contract.events), ["calendar-changed", "calendar-checked"]);
  assert.equal(Object.hasOwn(contract.operations, "family.today"), false);
});

test("queries are operator.read session actions, the page write is operator.write, the agent tools are the schedule and the four calendar writes with their first-running approval hook, the week is an operator.read Gateway method, and there is no command adapter", () => {
  const actions: { id: string; requiredScopes: string[] }[] = [];
  const tools: { name: string; optional?: boolean }[] = [];
  const methods: { method: string; scope?: string }[] = [];
  const hooks: { name: string; priority?: number; matcher?: readonly string[] }[] = [];
  const cli: string[] = [];
  let commands = 0;
  let cliCommands: readonly string[] = [];
  plugin.register({
    id: contract.pluginId,
    pluginConfig: { demo: true, timezone: "UTC" },
    registerService() {},
    registerSessionAction(action: { id: string; requiredScopes: string[] }) {
      actions.push({ id: action.id, requiredScopes: [...action.requiredScopes] });
    },
    registerCommand() {
      commands += 1;
    },
    registerTool(_factory: unknown, opts: { name: string; optional?: boolean }) {
      tools.push(opts);
    },
    on(name: string, _handler: unknown, opts?: { priority?: number; matcher?: readonly string[] }) {
      hooks.push({ name, ...opts });
    },
    registerGatewayMethod(method: string, _handler: unknown, opts?: { scope?: string }) {
      methods.push({ method, ...(opts?.scope ? { scope: opts.scope } : {}) });
    },
    registerCli(
      registrar: (ctx: { program: { command: (name: string) => unknown }; config: { gateway?: unknown } }) => void,
      opts?: { commands?: readonly string[]; descriptors?: readonly { name: string; hasSubcommands?: boolean }[] },
    ) {
      const declared = [...(opts?.commands ?? []), ...(opts?.descriptors?.map((descriptor) => descriptor.name) ?? [])];
      if (declared.length === 0) return;
      cliCommands = opts?.commands ?? [];
      assert.equal(opts?.descriptors?.[0]?.hasSubcommands, true);
      const node = {
        description: () => node,
        command: (name: string) => {
          cli.push(name);
          return node;
        },
        argument: () => node,
        option: () => node,
        action: () => node,
      };
      registrar({ program: { command: (name: string) => { cli.push(name); return node; } }, config: {} });
    },
  } as unknown as Parameters<typeof plugin.register>[0]);
  assert.deepEqual(actions, [
    { id: "family.calendar.write", requiredScopes: ["operator.write"] },
    { id: "family.members", requiredScopes: ["operator.read"] },
    { id: "family.schedule", requiredScopes: ["operator.read"] },
    { id: "family.weather", requiredScopes: ["operator.read"] },
  ]);
  const writes = ["calendar_create", "calendar_update", "calendar_move", "calendar_delete"];
  assert.deepEqual(tools, [...writes.map((name) => ({ name })), { name: "family_schedule" }]);
  assert.deepEqual(hooks, [{ name: "before_tool_call", priority: CALENDAR_HOOK_PRIORITY, matcher: writes }]);
  assert.deepEqual(methods, [{ method: "family.week", scope: "operator.read" }]);
  assert.equal(commands, 0);
  assert.deepEqual(cliCommands, ["family"]);
  assert.deepEqual(cli, ["family", "gog", "access", "setup"]);
});

test("both calendar events match the feature event id pattern, and calendar-checked carries nothing", () => {
  const eventId = new RegExp(FEATURE_EVENT_ID_PATTERN);
  assert.equal(eventId.test(CALENDAR_CHANGED_EVENT), true);
  assert.equal(eventId.test(CALENDAR_CHECKED_EVENT), true);
  assert.equal(eventId.test("calendar.changed"), false);
  assert.equal(Value.Check(CalendarCheckedSchema, {}), true);
  assert.equal(Value.Check(CalendarCheckedSchema, { at: "2026-10-02T15:00:00.000Z" }), false);
  assert.equal(Value.Check(CalendarChangedSchema, { reason: "external", calendarKeys: ["c4"], at: "2026-10-02T15:00:00.000Z" }), true);
  assert.equal(Value.Check(CalendarChangedSchema, { reason: "poll", calendarKeys: [], at: "2026-10-02T15:00:00.000Z" }), false);
  assert.equal(Value.Check(TodayPayloadSchema, { date: "2026-10-02", highlights: ["Dentist at 3:00 PM"], exceptions: [] }), true);
  assert.equal(Value.Check(TodayPayloadSchema, { date: "2026-10-02", highlights: ["a", "b", "c", "d"], exceptions: [] }), false);
});

test("CalendarWrite rejects an unknown op, a missing or multi-line requestId, and any extra field", () => {
  const requestId = "submit-1";
  const variants = [
    { op: "create", requestId, calendarKey: "c0", title: "Dentist", start: "2026-10-06T19:00:00.000Z", end: "2026-10-06T20:00:00.000Z" },
    { op: "update", requestId, id: "c0/e1", title: "Dentist", scope: "single" },
    { op: "move", requestId, id: "c0/e1", destinationKey: "c4" },
    { op: "delete", requestId, id: "c0/e1" },
  ];
  assert.equal(Value.Check(CalendarWriteSchema, { op: "archive", requestId, id: "c0/e1" }), false);
  for (const variant of variants) {
    assert.equal(Value.Check(CalendarWriteSchema, variant), true, variant.op);
    const { requestId: _requestId, ...without } = variant;
    assert.equal(Value.Check(CalendarWriteSchema, without), false, `${variant.op} without requestId`);
    assert.equal(Value.Check(CalendarWriteSchema, { ...variant, requestId: "" }), false, `${variant.op} blank`);
    assert.equal(Value.Check(CalendarWriteSchema, { ...variant, requestId: "a\nb" }), false, `${variant.op} newline`);
    assert.equal(Value.Check(CalendarWriteSchema, { ...variant, requestId: "k".repeat(257) }), false, `${variant.op} too long`);
    assert.equal(Value.Check(CalendarWriteSchema, { ...variant, calendarId: "family@group.calendar.google.com" }), false, `${variant.op} extra`);
  }
  assert.equal(Value.Check(CalendarWriteResultSchema, { ok: true, message: "Deleted **Dentist**." }), true);
  assert.equal(Value.Check(CalendarWriteResultSchema, { ok: true, message: "x", eventId: "c0/e1" }), false);
});
