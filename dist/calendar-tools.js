import { createStamper } from "./approval-stamp.js";
import { calendarChangeHook, calendarChangeTool, CHANGE_TOOLS, TOOL_OF } from "./calendar-change.js";
import { CALENDAR_CREATE_TOOL, CALENDAR_HOOK_PRIORITY, calendarCreateHook, calendarCreateTool, } from "./calendar-create.js";
/**
 * The hook and the four write tools, always together, sharing one stamp secret made here. One
 * before_tool_call hook covers all four; the stamp binds the tool name, so a stamp for one
 * tool never runs another. No hook, no tools.
 */
export function registerCalendarWrite(api, deps) {
    const stamper = createStamper();
    const create = calendarCreateHook(deps, stamper);
    const change = calendarChangeHook(deps, stamper);
    api.on("before_tool_call", async (event, ctx) => (event.toolName === CALENDAR_CREATE_TOOL ? create(event, ctx) : change(event, ctx)), {
        priority: CALENDAR_HOOK_PRIORITY,
        matcher: [CALENDAR_CREATE_TOOL, ...Object.keys(CHANGE_TOOLS)],
    });
    api.registerTool((ctx) => calendarCreateTool(deps, stamper, ctx), { name: CALENDAR_CREATE_TOOL });
    for (const op of Object.values(CHANGE_TOOLS)) {
        api.registerTool((ctx) => calendarChangeTool(op, deps, stamper, ctx), { name: TOOL_OF[op] });
    }
}
