import { TODAY_WIDGET_ID } from "./contract.js";
export const TODAY_HOME_METHOD = "family.todayHome";
export const TODAY_HOME_NAME = "family-today";
export const TODAY_KIND = `oc-family-pack:${TODAY_WIDGET_ID}`;
/** The main session Home reads. An unset agent is the default `main` agent. */
export function homeSessionKey(agentId) {
    const id = typeof agentId === "string" && agentId.trim() !== "" ? agentId.trim() : "main";
    return `agent:${id}:main`;
}
export function todayPutParams(sessionKey) {
    return {
        sessionKey,
        name: TODAY_HOME_NAME,
        title: "Today",
        content: { kind: "plugin", pluginKind: TODAY_KIND },
        placement: { size: "md" },
    };
}
export function todayOnHome(widgets) {
    return widgets.some((widget) => widget.name === TODAY_HOME_NAME || widget.pluginKind === TODAY_KIND);
}
/**
 * Place Today once on a fresh Home. After that, a missing card is a choice:
 * the Family page offers to pin it, and a person who cannot write sees neither.
 */
export function todayHomeDecision(input) {
    if (todayOnHome(input.widgets))
        return "ready";
    if (!input.canWrite)
        return "ready";
    if (!input.seeded)
        return "place";
    return "prompt";
}
/** `family.todayHome` answers `{ seeded: boolean }`. Anything else is not a seed read. */
export function seededFlag(payload) {
    if (!payload || typeof payload !== "object" || !("seeded" in payload))
        return undefined;
    const seeded = payload.seeded;
    return typeof seeded === "boolean" ? seeded : undefined;
}
/** Widgets from `board.get`. A payload with neither `widgets` nor `tabs` is not a board. */
export function widgetsOf(payload) {
    if (!payload || typeof payload !== "object")
        return undefined;
    const record = payload;
    if (!Array.isArray(record.widgets) && !Array.isArray(record.tabs))
        return undefined;
    const lists = [];
    if (Array.isArray(record.widgets))
        lists.push(...record.widgets);
    if (Array.isArray(record.tabs)) {
        for (const tab of record.tabs) {
            if (tab && typeof tab === "object" && Array.isArray(tab.widgets)) {
                lists.push(...tab.widgets);
            }
        }
    }
    return lists.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const widget = entry;
        const pluginKind = typeof widget.pluginKind === "string" ? widget.pluginKind : typeof widget.content?.pluginKind === "string" ? widget.content.pluginKind : undefined;
        const name = typeof widget.name === "string" ? widget.name : undefined;
        if (name === undefined && pluginKind === undefined)
            return [];
        return [{ name, pluginKind }];
    });
}
