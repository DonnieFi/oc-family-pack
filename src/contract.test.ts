import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import plugin from "./index.ts";
import {
  CALENDAR_CHANGED_EVENT,
  CalendarChangedSchema,
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

test("the contract registers exactly the three read queries", () => {
  assert.deepEqual(
    Object.entries(contract.operations).map(([name, operation]) => [name, operation.kind]),
    [
      ["family.week", "query"],
      ["family.members", "query"],
      ["family.weather", "query"],
    ],
  );
  assert.deepEqual(Object.keys(contract.events), []);
  assert.equal(Object.hasOwn(contract.operations, "family.today"), false);
  assert.equal(Object.hasOwn(contract.events, CALENDAR_CHANGED_EVENT), false);
});

test("registered queries are operator.read session actions and there is no command adapter", () => {
  const actions: { id: string; requiredScopes: string[] }[] = [];
  const cli: string[] = [];
  let commands = 0;
  let cliCommands: readonly string[] = [];
  plugin.register({
    id: contract.pluginId,
    pluginConfig: { demo: true, timezone: "UTC" },
    registerSessionAction(action: { id: string; requiredScopes: string[] }) {
      actions.push({ id: action.id, requiredScopes: [...action.requiredScopes] });
    },
    registerCommand() {
      commands += 1;
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
    { id: "family.members", requiredScopes: ["operator.read"] },
    { id: "family.weather", requiredScopes: ["operator.read"] },
    { id: "family.week", requiredScopes: ["operator.read"] },
  ]);
  assert.equal(commands, 0);
  assert.deepEqual(cliCommands, ["family"]);
  assert.deepEqual(cli, ["family", "gog", "access", "setup"]);
});

test("calendar-changed matches the feature event id pattern and is not registered", () => {
  const eventId = new RegExp(FEATURE_EVENT_ID_PATTERN);
  assert.equal(eventId.test(CALENDAR_CHANGED_EVENT), true);
  assert.equal(eventId.test("calendar.changed"), false);
  assert.equal(Value.Check(CalendarChangedSchema, { reason: "external", calendarKeys: ["c4"], at: "2026-10-02T15:00:00.000Z" }), true);
  assert.equal(Value.Check(CalendarChangedSchema, { reason: "poll", calendarKeys: [], at: "2026-10-02T15:00:00.000Z" }), false);
  assert.equal(Value.Check(TodayPayloadSchema, { date: "2026-10-02", highlights: ["Dentist at 3:00 PM"], exceptions: [] }), true);
  assert.equal(Value.Check(TodayPayloadSchema, { date: "2026-10-02", highlights: ["a", "b", "c", "d"], exceptions: [] }), false);
});

test("CalendarWrite rejects an unknown op", () => {
  assert.equal(Value.Check(CalendarWriteSchema, { op: "archive", id: "c0/e1" }), false);
  assert.equal(
    Value.Check(CalendarWriteSchema, {
      op: "create",
      title: "Dentist",
      start: "2026-10-06T19:00:00.000Z",
      end: "2026-10-06T20:00:00.000Z",
    }),
    true,
  );
  assert.equal(Value.Check(CalendarWriteSchema, { op: "update", id: "c0/e1", title: "Dentist", scope: "single" }), true);
  assert.equal(Value.Check(CalendarWriteSchema, { op: "move", id: "c0/e1", destinationKey: "c4" }), true);
  assert.equal(Value.Check(CalendarWriteSchema, { op: "delete", id: "c0/e1" }), true);
});
