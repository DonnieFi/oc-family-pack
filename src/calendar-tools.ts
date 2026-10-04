import { createStamper } from "./approval-stamp.ts";
import { calendarChangeHook, calendarChangeTool, CHANGE_TOOLS, TOOL_OF } from "./calendar-change.ts";
import {
  CALENDAR_CREATE_TOOL,
  CALENDAR_HOOK_PRIORITY,
  calendarCreateHook,
  calendarCreateTool,
  type CalendarTool,
  type CalendarWriteDeps,
  type HookContext,
  type HookEvent,
  type HookResult,
  type ToolContext,
} from "./calendar-create.ts";
import type { ChangeOp } from "./calendar-write.ts";

export type CalendarWriteApi = {
  on: (
    hookName: "before_tool_call",
    handler: (event: HookEvent, ctx: HookContext) => Promise<HookResult | undefined>,
    opts: { priority: number; matcher: readonly [string, ...string[]] },
  ) => void;
  registerTool: (factory: (ctx: ToolContext) => CalendarTool, opts: { name: string }) => void;
};

/**
 * The hook and the four write tools, always together, sharing one stamp secret made here. One
 * before_tool_call hook covers all four; the stamp binds the tool name, so a stamp for one
 * tool never runs another. No hook, no tools.
 */
export function registerCalendarWrite(api: CalendarWriteApi, deps: CalendarWriteDeps): void {
  const stamper = createStamper();
  const create = calendarCreateHook(deps, stamper);
  const change = calendarChangeHook(deps, stamper);
  api.on("before_tool_call", async (event, ctx) => (event.toolName === CALENDAR_CREATE_TOOL ? create(event, ctx) : change(event, ctx)), {
    priority: CALENDAR_HOOK_PRIORITY,
    matcher: [CALENDAR_CREATE_TOOL, ...Object.keys(CHANGE_TOOLS)],
  });
  api.registerTool((ctx) => calendarCreateTool(deps, stamper, ctx), { name: CALENDAR_CREATE_TOOL });
  for (const op of Object.values(CHANGE_TOOLS) as ChangeOp[]) {
    api.registerTool((ctx) => calendarChangeTool(op, deps, stamper, ctx), { name: TOOL_OF[op] });
  }
}
