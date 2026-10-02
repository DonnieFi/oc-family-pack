import {
  defineControlUiPlugin,
  type ControlUiAgent,
  type ControlUiComponentHandle,
  type ControlUiDialogProps,
  type ControlUiHost,
  type ControlUiSessionListSubscription,
  type ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";
import { mixTowardInk } from "./contrast.ts";
import type { CalendarRef, FamilyEvent, Member, WeekPayload } from "./types.ts";
import { addDays, boundWeekStart, localDate } from "./week.ts";
import "./control-ui.css";

const PAGE_ID = "family";

type Load =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "ready"; week: WeekPayload }
  | { kind: "failed"; message: string };
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return node;
}

function on<T extends HTMLElement, E extends keyof HTMLElementEventMap>(node: T, type: E, listener: (event: HTMLElementEventMap[E]) => void): T {
  node.addEventListener(type, listener);
  return node;
}

function paint<T extends HTMLElement>(node: T, vars: Record<string, string>): T {
  for (const [name, value] of Object.entries(vars)) node.style.setProperty(name, value);
  return node;
}

const ICONS = {
  calendar: ["M8 2v4M16 2v4", "M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"],
  cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"],
  alert: ["M12 9v4M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
  prev: ["m15 18-6-6 6-6"],
  next: ["m9 18 6-6-6-6"],
  close: ["M18 6 6 18M6 6l12 12"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Setup hints mark commands with backticks. */
const richText = (text: string) => text.split("`").map((part, index) => (index % 2 ? h("code", {}, part) : part));

const emptyState = (iconName: keyof typeof ICONS, title: string, text: string) =>
  h("div", { class: "ocfp-empty" }, h("div", { class: "ocfp-empty-title" }, icon(iconName), title), h("p", {}, ...richText(text)));

function formats(timezone: string, locale: string) {
  const utc = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  return {
    weekday: utc({ weekday: "short" }),
    day: utc({ day: "numeric" }),
    month: utc({ month: "long" }),
    monthDay: utc({ month: "short", day: "numeric" }),
    long: utc({ weekday: "long", month: "long", day: "numeric" }),
    year: utc({ year: "numeric" }),
    time: new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
    when: new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
}

const noon = (date: string) => new Date(`${date}T12:00:00Z`);

function shiftWeek(start: string, days: number, today: string): string | undefined {
  try {
    return boundWeekStart(addDays(start, days), today);
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}
const isWeekend = (date: string) => [0, 6].includes(noon(date).getUTCDay());

export function mountFamilyPage(container: HTMLElement, initial: ControlUiViewContext) {
  const host: ControlUiHost = initial.host;
  const feature = createFeatureClient(contract, host);
  const content = h("div", { class: "ocfp-stack" });
  const chatStrip = h("section", { class: "ocfp-chat-strip ocfp-panel", "aria-label": "Chat with an agent" });
  const dialogHolder = h("div");
  const root = h("div", { class: "oc-family-pack" }, h("div", { class: "ocfp-app" }, content, chatStrip), dialogHolder);
  container.append(root);

  const browserToday = (now = new Date()) =>
    `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  /** `?start=` is clamped to 8 weeks back through 52 weeks ahead. family.week can still be called outside that window. */
  const requestedStart = (props: ControlUiViewContext["props"], today: string) => boundWeekStart(props.start, today);
  let start = requestedStart(initial.props, browserToday());
  let person: string | null = null;
  let selectedDay = "";
  let dialog: ControlUiComponentHandle<ControlUiDialogProps> | undefined;
  let stopWatching: () => void = () => {};
  let agentHandles: ControlUiComponentHandle<{ agentId: string; label: string }>[] = [];
  let agentSignature = "";
  let disposed = false;
  const pageAbort = new AbortController();
  const lifetime = AbortSignal.any([initial.signal, pageAbort.signal]);
  const alive = () => !disposed && !initial.signal.aborted;
  lifetime.addEventListener("abort", () => stopWatching(), { once: true });

  function watchWeek() {
    stopWatching();
    if (!alive()) return;
    if (!host.connection.canRead) {
      render({ kind: "denied" });
      return;
    }
    root.setAttribute("aria-busy", "true");
    if (!content.hasChildNodes()) render({ kind: "loading" });
    stopWatching = feature.watch("family.week", start ? { start } : {}, {
      events: [],
      onChange: (week) => render({ kind: "ready", week }),
      onError: (error) => render({ kind: "failed", message: error.message }),
    });
  }

  function weekHref(target: string | undefined) {
    return host.navigation.pageHref({ id: PAGE_ID, ...(target ? { params: { start: target } } : {}) });
  }

  function weekLink(target: string | undefined, attrs: Attrs, ...children: Child[]) {
    return on(h("a", { ...attrs, href: weekHref(target) }, ...children), "click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      host.navigation.openPage({ id: PAGE_ID, ...(target ? { params: { start: target } } : {}) });
    });
  }

  function render(load: Load) {
    if (!alive()) return;
    root.removeAttribute("aria-busy");
    if (load.kind === "loading") {
      content.replaceChildren(
        h("header", { class: "ocfp-masthead" }, h("div", {}, h("p", { class: "ocfp-kicker" }, "Family week"), h("h1", { class: "ocfp-title" }, "This week"))),
        h("div", { class: "ocfp-notice ocfp-panel", role: "status" }, emptyState("calendar", "Loading the week", "Reading calendars and weather.")),
      );
      return;
    }
    if (load.kind === "denied") {
      content.replaceChildren(
        h("header", { class: "ocfp-masthead" }, h("div", {}, h("p", { class: "ocfp-kicker" }, "Family week"), h("h1", { class: "ocfp-title" }, "This week"))),
        h("div", { class: "ocfp-notice ocfp-panel", role: "status" }, h("p", {}, "You need read access to see the family week.")),
      );
      return;
    }
    if (load.kind === "failed") {
      const retry = on(h("button", { type: "button", class: "ocfp-btn ocfp-btn-today" }, "Try again"), "click", watchWeek);
      content.replaceChildren(
        h("header", { class: "ocfp-masthead" }, h("div", {}, h("p", { class: "ocfp-kicker" }, "Family week"), h("h1", { class: "ocfp-title" }, "This week"))),
        h(
          "div",
          { class: "ocfp-notice ocfp-panel is-error", role: "alert" },
          h(
            "div",
            { class: "ocfp-empty" },
            h("div", { class: "ocfp-empty-title" }, icon("alert"), "Couldn't load the week."),
            h("p", { class: "ocfp-muted-reason" }, load.message),
          ),
          retry,
        ),
      );
      return;
    }
    renderWeek(load.week);
  }

  function renderWeek(week: WeekPayload) {
    const fmt = formats(week.range.timezone, host.locale);
    const members = new Map<string, Member>(week.members.map((member) => [member.profileId, member]));
    const events = new Map<string, FamilyEvent>(week.calendar.status === "ok" ? week.calendar.data.map((event) => [event.id, event]) : []);
    const inWeek = week.days.some((day) => day.isToday);
    if (!week.days.some((day) => day.date === selectedDay)) {
      selectedDay = (week.days.find((day) => day.isToday) ?? week.days[0])?.date ?? "";
    }

    const calendars = new Map<string, CalendarRef>(week.calendars.map((calendar) => [calendar.key, calendar]));
    const calendarOf = (event: FamilyEvent) => calendars.get(event.calendarKey);
    const isShared = (event: FamilyEvent) => calendarOf(event)?.kind === "shared";
    const ownerIds = (event: FamilyEvent) => calendarOf(event)?.ownerIds ?? [];
    const theme = getComputedStyle(document.documentElement);
    const ink = theme.getPropertyValue("--text-strong").trim() || "#211e1a";
    const card = theme.getPropertyValue("--card").trim() || "#ffffff";
    const light = document.documentElement.getAttribute("data-theme-mode") === "light";
    const onCard = (color: string) => (light && !color.startsWith("var(") ? mixTowardInk(color, ink, card).color : color);
    const eventColor = (event: FamilyEvent) =>
      isShared(event) ? "var(--family-neutral)" : onCard(members.get(ownerIds(event)[0] ?? "")?.color ?? "var(--family-neutral)");
    const matches = (event: FamilyEvent) => !person || isShared(event) || ownerIds(event).includes(person);

    const start = noon(week.range.start);
    const end = noon(week.range.end);
    const title =
      start.getUTCMonth() === end.getUTCMonth()
        ? `${fmt.month.format(start)} ${fmt.day.format(start)} – ${fmt.day.format(end)}`
        : `${fmt.monthDay.format(start)} – ${fmt.monthDay.format(end)}`;
    const count = new Set(week.days.flatMap((day) => day.eventIds)).size;
    const masthead = h(
      "header",
      { class: "ocfp-masthead" },
      h(
        "div",
        {},
        h("p", { class: "ocfp-kicker" }, week.mode === "demo" ? "Family week · Demo" : "Family week"),
        h("h1", { class: "ocfp-title" }, title),
        h(
          "p",
          { class: "ocfp-subtitle" },
          ...(inWeek ? ["Today is ", h("strong", {}, fmt.long.format(noon(week.today))), " · "] : [`${fmt.year.format(end)} · `]),
          week.calendar.status === "ok" ? `${count} ${count === 1 ? "event" : "events"} this week` : "Calendar not connected",
        ),
      ),
      h(
        "nav",
        { class: "ocfp-week-nav", "aria-label": "Change week" },
        weekLink(shiftWeek(week.range.start, -7, week.today), { class: "ocfp-btn ocfp-btn-icon", "aria-label": "Previous week" }, icon("prev")),
        weekLink(undefined, { class: "ocfp-btn ocfp-btn-today", "aria-current": inWeek ? "true" : "false" }, "Today"),
        weekLink(shiftWeek(week.range.start, 7, week.today), { class: "ocfp-btn ocfp-btn-icon", "aria-label": "Next week" }, icon("next")),
      ),
    );

    const filters = h("div", { class: "ocfp-filters", role: "group", "aria-label": "Show events for" });
    const renderFilters = () => {
      const chip = (id: string | null, label: string, color: string | undefined, role: string | undefined) => {
        const button = on(
          h("button", { type: "button", class: "ocfp-chip", "aria-pressed": String(person === id) }, h("span", { class: "ocfp-chip-dot", "aria-hidden": "true" }), label, role ? h("span", { class: "ocfp-chip-role" }, role) : null),
          "click",
          () => {
            person = person === id || id === null ? null : id;
            renderFilters();
            applyFilter();
          },
        );
        return color ? paint(button, { "--ocfp-chip": color }) : button;
      };
      filters.replaceChildren(
        chip(null, "Everyone", undefined, undefined),
        ...week.members.map((member) => chip(member.profileId, member.displayName, member.color, member.role === "guest" ? "guest" : undefined)),
      );
    };
    renderFilters();
    filters.hidden = week.members.length === 0;

    const weather = h("aside", { class: "ocfp-weather ocfp-panel", "aria-label": "Weather" }, ...weatherContent(week, fmt));

    const notice =
      week.calendar.status === "ok"
        ? week.calendar.warnings.length
          ? h("div", { class: "ocfp-notice ocfp-panel is-error", role: "status" }, emptyState("alert", "Some calendars are unavailable", week.calendar.warnings.join(" ")))
          : null
        : h(
            "div",
            { class: `ocfp-notice ocfp-panel${week.calendar.status === "error" ? " is-error" : ""}`, role: "status" },
            week.calendar.status === "unconfigured"
              ? emptyState("calendar", "Connect your family calendars", week.calendar.hint)
              : emptyState("alert", "Calendar unavailable", week.calendar.message),
          );

    const timeLabel = (event: FamilyEvent, date: string) => {
      if (event.allDay) return "All day";
      const startsToday = localDate(Date.parse(event.start), week.range.timezone) === date;
      return startsToday ? fmt.time.format(new Date(event.start)) : `until ${fmt.time.format(new Date(event.end))}`;
    };
    const ownerDots = (event: FamilyEvent) =>
      isShared(event)
        ? h("span", { class: "ocfp-chip-role" }, "Family")
        : h(
            "span",
            { class: "ocfp-owner-dots", "aria-hidden": "true" },
            ...ownerIds(event).flatMap((id) => {
              const member = members.get(id);
              return member ? [paint(h("span", { class: "ocfp-owner-dot" }), { "--ocfp-dot": onCard(member.color) })] : [];
            }),
          );
    const eventCard = (event: FamilyEvent, date: string) =>
      paint(
        on(
          h(
            "button",
            { type: "button", class: `ocfp-event${event.allDay ? " is-all-day" : ""}`, "data-event-id": event.id, "aria-haspopup": "dialog" },
            h("span", { class: "ocfp-event-meta" }, h("span", {}, timeLabel(event, date)), ownerDots(event)),
            h("span", { class: "ocfp-event-title" }, event.title),
            event.location ? h("span", { class: "ocfp-event-location" }, event.location) : null,
          ),
          "click",
          (click) => openEvent(week, event, calendarOf(event), eventColor(event), click.currentTarget instanceof HTMLElement ? click.currentTarget : null),
        ),
        { "--ocfp-event": eventColor(event) },
      );

    const grid = h(
      "div",
      { class: "ocfp-week-grid ocfp-panel is-entering" },
      ...week.days.map((day) => {
        const date = noon(day.date);
        const cards = day.eventIds.flatMap((id) => {
          const event = events.get(id);
          return event ? [eventCard(event, day.date)] : [];
        });
        const classes = ["ocfp-day", day.isToday && "is-today", isWeekend(day.date) && "is-weekend", selectedDay === day.date && "is-selected"];
        return h(
          "section",
          { class: classes.filter(Boolean).join(" "), id: `ocfp-day-${day.date}`, role: "region", "aria-label": fmt.long.format(date) },
          h(
            "header",
            { class: "ocfp-day-head" },
            h("span", { class: "ocfp-day-weekday" }, fmt.weekday.format(date), day.isToday ? h("span", { class: "ocfp-today-badge" }, "Today") : null),
            h("span", { class: "ocfp-day-number" }, fmt.day.format(date)),
          ),
          h("div", { class: "ocfp-day-events" }, ...(cards.length ? cards : [week.calendar.status === "ok" ? h("p", { class: "ocfp-day-empty" }, "Nothing planned") : null])),
        );
      }),
    );

    const tabs = h("div", { class: "ocfp-day-tabs", role: "group", "aria-label": "Day" });
    const selectDay = (date: string, focus: boolean) => {
      selectedDay = date;
      for (const node of grid.querySelectorAll(".ocfp-day")) node.classList.toggle("is-selected", node.id === `ocfp-day-${date}`);
      for (const tab of tabs.querySelectorAll<HTMLButtonElement>(".ocfp-day-tab")) {
        const selected = tab.dataset.date === date;
        tab.setAttribute("aria-pressed", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
      }
    };
    tabs.append(
      ...week.days.map((day) =>
        on(
          on(
            h(
              "button",
              {
                type: "button",
                class: `ocfp-day-tab${day.isToday ? " is-today" : ""}`,
                "data-date": day.date,
                "aria-pressed": String(selectedDay === day.date),
                ...(day.isToday ? { "aria-current": "date" } : {}),
                tabindex: selectedDay === day.date ? "0" : "-1",
                "aria-label": fmt.long.format(noon(day.date)),
              },
              day.isToday ? "Today" : fmt.weekday.format(noon(day.date)),
              h("b", {}, fmt.day.format(noon(day.date))),
            ),
            "click",
            () => selectDay(day.date, false),
          ),
          "keydown",
          (event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            const index = week.days.findIndex((entry) => entry.date === selectedDay);
            const next = week.days[(index + step + week.days.length) % week.days.length];
            if (next) selectDay(next.date, true);
          },
        ),
      ),
    );

    const applyFilter = () => {
      for (const node of grid.querySelectorAll<HTMLElement>(".ocfp-event[data-event-id]")) {
        const event = events.get(node.dataset.eventId ?? "");
        node.classList.toggle("is-dimmed", event !== undefined && !matches(event));
      }
    };
    applyFilter();

    content.replaceChildren(
      masthead,
      filters,
      h("div", { class: "ocfp-layout" }, weather, h("section", { class: "ocfp-week-area", "aria-label": title }, notice, tabs, grid)),
    );
  }

  function weatherContent(week: WeekPayload, fmt: ReturnType<typeof formats>): Child[] {
    const kicker = h("p", { class: "ocfp-kicker" }, "Weather");
    const weather = week.weather;
    if (weather.status !== "ok") {
      return [
        kicker,
        weather.status === "unconfigured" ? emptyState("cloud", "Weather is off", weather.hint) : emptyState("alert", "Weather unavailable", weather.message),
      ];
    }
    const card = weather.data;
    const observed = card.observedAt ? ` · updated ${fmt.time.format(new Date(card.observedAt))}` : "";
    return [
      h("div", { class: "ocfp-weather-head" }, kicker, h("span", { class: "ocfp-weather-place" }, card.stationName)),
      h(
        "div",
        { class: "ocfp-weather-now" },
        card.tempC === undefined ? null : h("span", { class: "ocfp-weather-temp" }, `${Math.round(card.tempC)}°`),
        card.condition ? h("span", { class: "ocfp-weather-condition" }, card.condition) : null,
      ),
      card.highC === undefined && card.lowC === undefined
        ? null
        : h(
            "div",
            { class: "ocfp-weather-range" },
            card.highC === undefined ? null : h("span", {}, "High ", h("b", {}, `${Math.round(card.highC)}°`)),
            card.lowC === undefined ? null : h("span", {}, "Low ", h("b", {}, `${Math.round(card.lowC)}°`)),
          ),
      card.forecast.length
        ? h(
            "ul",
            { class: "ocfp-forecast", "aria-label": "Forecast" },
            ...card.forecast.map((period) =>
              h("li", {}, h("span", { class: "ocfp-forecast-period" }, period.period), h("span", { class: "ocfp-forecast-summary" }, period.summary)),
            ),
          )
        : null,
      h("p", { class: "ocfp-source-note" }, `Environment Canada${observed}`),
    ];
  }

  function closeDialog() {
    dialog?.dispose();
    dialog = undefined;
  }

  function openEvent(week: WeekPayload, event: FamilyEvent, calendar: CalendarRef | undefined, color: string, trigger: HTMLElement | null) {
    const timezone = week.range.timezone;
    const fmt = formats(timezone, host.locale);
    const members = new Map(week.members.map((member) => [member.profileId, member]));
    const describeWhen = () => {
      if (event.allDay) {
        const last = addDays(event.end, -1);
        return last > event.start
          ? `${fmt.long.format(noon(event.start))} – ${fmt.long.format(noon(last))}`
          : `${fmt.long.format(noon(event.start))}, all day`;
      }
      const sameDay = localDate(Date.parse(event.start), timezone) === localDate(Date.parse(event.end), timezone);
      return `${fmt.when.format(new Date(event.start))} – ${(sameDay ? fmt.time : fmt.when).format(new Date(event.end))}`;
    };
    const who =
      calendar?.kind === "shared"
        ? "Everyone"
        : h(
            "span",
            { class: "ocfp-who-list" },
            ...(calendar?.ownerIds ?? []).flatMap((id) => {
              const member = members.get(id);
              return member
                ? [h("span", { class: "ocfp-who" }, paint(h("span", { class: "ocfp-owner-dot" }), { "--ocfp-dot": member.color }), member.displayName)]
                : [];
            }),
          );
    const rows: [string, Child][] = [
      ["When", describeWhen()],
      ...(event.location ? [["Where", event.location] satisfies [string, Child]] : []),
      ["Who", who],
      ...(calendar ? [["Calendar", `${calendar.label} · ${calendar.kind}`] satisfies [string, Child]] : []),
    ];
    const details = paint(
      h(
        "div",
        { class: "ocfp-dialog" },
        h("div", { class: "ocfp-dialog-bar", "aria-hidden": "true" }),
        h(
          "div",
          { class: "ocfp-dialog-head" },
          h("h2", {}, event.title),
          on(h("button", { type: "button", class: "ocfp-btn ocfp-btn-icon ocfp-btn-quiet", "aria-label": "Close event details" }, icon("close")), "click", closeDialog),
        ),
        h("dl", { class: "ocfp-dialog-body" }, ...rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)])),
        event.htmlLink
          ? h(
              "a",
              { class: "ocfp-dialog-link", href: event.htmlLink, target: "_blank", rel: "noopener noreferrer" },
              "Open in Google Calendar",
              icon("external"),
            )
          : null,
      ),
      { "--ocfp-event": color },
    );
    closeDialog();
    dialog = host.components.mountDialog(dialogHolder, {
      label: event.title,
      content: details,
      style: "--openclaw-modal-width: 440px",
      returnFocusTarget: trigger,
      onCancel: closeDialog,
    });
  }

  function renderAgents() {
    if (!alive()) return;
    const agents = host.agents.rows.filter((agent: ControlUiAgent) => agent.kind !== "system");
    const name = (agent: ControlUiAgent) => agent.identity?.name?.trim() || agent.name?.trim() || agent.id;
    const signature = agents.map((agent) => `${agent.id}\u0000${name(agent)}\u0000${agent.identity?.emoji ?? ""}`).join("\u0001");
    if (signature === agentSignature && chatStrip.hasChildNodes()) return;
    agentSignature = signature;
    for (const handle of agentHandles) handle.dispose();
    agentHandles = [];
    const label = h("span", { class: "ocfp-chat-label" }, "Chat with");
    if (agents.length === 0) {
      chatStrip.replaceChildren(label, h("p", { class: "ocfp-chat-hint" }, "No agents are available to this login. Create an agent to chat from here."));
      return;
    }
    chatStrip.replaceChildren(
      label,
      ...agents.map((agent) => {
        const avatar = h("span", { class: "ocfp-agent-avatar", "aria-hidden": "true" });
        agentHandles.push(host.components.mountAgentAvatar(avatar, { agentId: agent.id, label: name(agent) }));
        return on(h("button", { type: "button", class: "ocfp-agent" }, avatar, name(agent)), "click", (click) => {
          if (click.currentTarget instanceof HTMLButtonElement) void openAgentChat(agent.id, click.currentTarget);
        });
      }),
    );
  }

  /** The agent's main session. Stops after 10 seconds so the chat button cannot stay disabled. */
  function findMainSession(agentId: string): Promise<string | undefined> {
    const listed = host.sessions.rows.find((row) => row.agentId === agentId && row.isMain);
    if (listed) return Promise.resolve(listed.key);
    return new Promise((resolve, reject) => {
      let settled = false;
      let subscription: ControlUiSessionListSubscription | undefined;
      const stop = () => {
        clearTimeout(timer);
        lifetime.removeEventListener("abort", onAbort);
        subscription?.dispose();
      };
      const succeed = (key: string | undefined) => {
        if (settled) return;
        settled = true;
        stop();
        resolve(key);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stop();
        reject(error);
      };
      const onAbort = () => succeed(undefined);
      const timer = setTimeout(() => fail(new Error("timed out")), 10_000);
      if (!alive()) {
        succeed(undefined);
        return;
      }
      lifetime.addEventListener("abort", onAbort, { once: true });
      subscription = host.sessions.observe({ agentId, limit: 200 }, ({ result, loading, error }) => {
        if (settled || !alive()) return;
        if (loading || (!result && !error)) return;
        if (error) fail(new Error(error));
        else succeed(result?.sessions.find((row) => row.isMain)?.key);
      });
      if (settled) subscription.dispose();
    });
  }

  async function openAgentChat(agentId: string, button: HTMLButtonElement) {
    if (!alive()) return;
    button.disabled = true;
    chatStrip.querySelector(".ocfp-chat-error")?.remove();
    try {
      const found = await findMainSession(agentId);
      if (!alive()) return;
      const sessionKey = found ?? (await host.sessions.create({ agentId }));
      if (!alive()) return;
      if (!sessionKey) throw new Error("The Gateway did not create a session.");
      host.sessions.open({ sessionKey, agentId });
    } catch (error) {
      if (!alive()) return;
      const reason = error instanceof Error ? error.message : String(error);
      chatStrip.append(
        h(
          "div",
          { class: "ocfp-chat-error", role: "alert" },
          h("p", { class: "ocfp-chat-error-title" }, "Couldn't open the chat."),
          h("p", { class: "ocfp-muted-reason" }, reason),
        ),
      );
    } finally {
      if (alive()) button.disabled = false;
    }
  }

  const stopHost = host.subscribe(renderAgents);
  renderAgents();
  watchWeek();

  return {
    update(next: ControlUiViewContext) {
      if (!alive()) return;
      const nextStart = requestedStart(next.props, browserToday());
      if (nextStart !== start) {
        start = nextStart;
        closeDialog();
        watchWeek();
      }
    },
    dispose() {
      disposed = true;
      pageAbort.abort();
      stopWatching();
      stopHost();
      closeDialog();
      for (const handle of agentHandles) handle.dispose();
      root.remove();
    },
  };
}

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({ id: PAGE_ID, label: "Family", page: { id: PAGE_ID }, icon: "calendarClock" });
    host.ui.registerPage({ id: PAGE_ID, label: "Family", mount: mountFamilyPage });
  },
});
