import { TODAY_WIDGET_ID } from "./contract.ts";

export const TODAY_HOME_METHOD = "family.todayHome";
export const TODAY_HOME_NAME = "family-today";
export const TODAY_KIND = `oc-family-pack:${TODAY_WIDGET_ID}`;

export type TodayWidgetRef = { name?: string | undefined; pluginKind?: string | undefined };
export type TodayHomeDecision = "place" | "prompt" | "ready";

/** The main session Home reads. An unset agent is the default `main` agent. */
export function homeSessionKey(agentId: string | null | undefined): string {
  const id = typeof agentId === "string" && agentId.trim() !== "" ? agentId.trim() : "main";
  return `agent:${id}:main`;
}

export function todayPutParams(sessionKey: string) {
  return {
    sessionKey,
    name: TODAY_HOME_NAME,
    title: "Today",
    content: { kind: "plugin" as const, pluginKind: TODAY_KIND },
    placement: { size: "md" as const },
  };
}

export function todayOnHome(widgets: readonly TodayWidgetRef[]): boolean {
  return widgets.some((widget) => widget.name === TODAY_HOME_NAME || widget.pluginKind === TODAY_KIND);
}

/**
 * Place Today once on a fresh Home. After that, a missing card is a choice:
 * the Family page offers to pin it, and a person who cannot write sees neither.
 */
export function todayHomeDecision(input: { canWrite: boolean; seeded: boolean; widgets: readonly TodayWidgetRef[] }): TodayHomeDecision {
  if (todayOnHome(input.widgets)) return "ready";
  if (!input.canWrite) return "ready";
  if (!input.seeded) return "place";
  return "prompt";
}

/** `family.todayHome` answers `{ seeded: boolean }`. Anything else is not a seed read. */
export function seededFlag(payload: unknown): boolean | undefined {
  if (!payload || typeof payload !== "object" || !("seeded" in payload)) return undefined;
  const seeded = (payload as { seeded: unknown }).seeded;
  return typeof seeded === "boolean" ? seeded : undefined;
}

/** Widgets from `board.get`. A payload with neither `widgets` nor `tabs` is not a board. */
export function widgetsOf(payload: unknown): TodayWidgetRef[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { widgets?: unknown; tabs?: unknown };
  if (!Array.isArray(record.widgets) && !Array.isArray(record.tabs)) return undefined;
  const lists: unknown[] = [];
  if (Array.isArray(record.widgets)) lists.push(...record.widgets);
  if (Array.isArray(record.tabs)) {
    for (const tab of record.tabs) {
      if (tab && typeof tab === "object" && Array.isArray((tab as { widgets?: unknown }).widgets)) {
        lists.push(...(tab as { widgets: unknown[] }).widgets);
      }
    }
  }
  return lists.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const widget = entry as { name?: unknown; pluginKind?: unknown; content?: { pluginKind?: unknown } };
    const pluginKind =
      typeof widget.pluginKind === "string" ? widget.pluginKind : typeof widget.content?.pluginKind === "string" ? widget.content.pluginKind : undefined;
    const name = typeof widget.name === "string" ? widget.name : undefined;
    if (name === undefined && pluginKind === undefined) return [];
    return [{ name, pluginKind }];
  });
}

