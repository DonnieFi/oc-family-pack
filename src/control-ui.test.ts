import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlUiHost, ControlUiSessionListSnapshot, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import familyUi, { mountFamilyPage, mountTodayWidget, observedText, READ_ONLY_HERE, staleText } from "./control-ui.ts";
import type { WeekPayload } from "./types.ts";
import { boundWeekStart } from "./week.ts";

const DATES = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

function week(): WeekPayload {
  return {
    mode: "demo",
    range: { start: DATES[0] ?? "", end: DATES[6] ?? "", timezone: "UTC" },
    today: "2026-09-30",
    days: DATES.map((date) => ({
      date,
      isToday: date === "2026-09-30",
      eventIds: date === "2026-09-30" ? ["e-alex", "e-family"] : [],
    })),
    members: [
      { profileId: "alex", displayName: "Alex", role: "parent", color: "oklch(0.72 0.14 245)" },
      { profileId: "sam", displayName: "Sam", role: "parent", color: "oklch(0.72 0.16 55)" },
    ],
    calendars: [
      { key: "c0", label: "Alex", kind: "personal", ownerIds: ["alex"] },
      { key: "c4", label: "Family", kind: "shared", ownerIds: ["alex", "sam"] },
    ],
    calendar: {
      status: "ok",
      warnings: [],
      data: [
        {
          id: "e-alex",
          title: "Dentist",
          start: "2026-09-30T13:30:00.000Z",
          end: "2026-09-30T14:30:00.000Z",
          allDay: false,
          calendarKey: "c0",
        },
        {
          id: "e-family",
          title: "Movie night",
          start: "2026-09-30T23:00:00.000Z",
          end: "2026-10-01T01:00:00.000Z",
          allDay: false,
          calendarKey: "c4",
        },
      ],
    },
    weather: { status: "unconfigured", hint: "Weather is not set up." },
    canEdit: false,
    calendarsReadOnly: false,
  };
}

type Listen = (snapshot: ControlUiSessionListSnapshot) => void;

/** Every page a test mounts is disposed afterwards, so its clock never outlives the test. */
const mounted: AbortController[] = [];
afterEach(() => {
  for (const controller of mounted.splice(0)) controller.abort();
});

function installDom(mode: "light" | "dark") {
  const window = parseHTML("<!doctype html><html><body></body></html>");
  const { document, HTMLButtonElement, HTMLElement, Event } = window;
  document.documentElement.setAttribute("data-theme-mode", mode);
  globalThis.document = document;
  globalThis.HTMLButtonElement = HTMLButtonElement;
  globalThis.HTMLElement = HTMLElement;
  const tokens =
    mode === "light"
      ? { "--text-strong": "#211e1a", "--card": "#fff" }
      : { "--text-strong": "#f4f4f5", "--card": "#161920" };
  globalThis.getComputedStyle = (() => ({
    getPropertyValue(name: string) {
      return tokens[name as keyof typeof tokens] ?? "";
    },
  })) as unknown as typeof getComputedStyle;
  return { document, Event };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function mountPage(options: {
  mode?: "light" | "dark";
  canRead?: boolean;
  props?: Record<string, unknown>;
  /** What the family.week Gateway method answers: the week, or an error it rejects with. */
  result?: WeekPayload | Error;
  request?: (...args: unknown[]) => Promise<unknown>;
  observe?: (listener: Listen) => void;
  create?: () => Promise<string | null>;
}) {
  const { document, Event } = installDom(options.mode ?? "dark");
  const container = document.createElement("div");
  document.body.append(container);
  const signal = new AbortController();
  mounted.push(signal);
  const listeners = new Map<string, (payload: unknown) => void>();
  let requests = 0;
  let creates = 0;
  let opens: string[] = [];
  let sessionDisposes = 0;
  const calls: unknown[][] = [];
  const dialogs: { content: HTMLElement }[] = [];
  const host = {
    apiVersion: 1,
    pluginId: "oc-family-pack",
    signal: new AbortController().signal,
    basePath: "",
    locale: "en-US",
    redact: (text: string) => text,
    connection: {
      connected: true,
      canRead: options.canRead ?? true,
      canWrite: true,
      canGrant: false,
      canAdmin: false,
      assistantAgentId: null,
    },
    components: {
      mountAgentAvatar: () => ({ dispose() {}, update() {} }),
      mountDialog: (_holder: unknown, props: { content: HTMLElement }) => {
        dialogs.push(props);
        return { dispose() {}, update() {} };
      },
    },
    request: (...args: unknown[]) => {
      requests += 1;
      calls.push(args);
      if (options.request) return options.request(...args);
      const result = options.result ?? week();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    subscribe: () => () => {},
    sessions: {
      rows: [],
      selectedKey: "",
      normalizeKey: (key: string) => key,
      refresh: async () => {},
      observe: (_query: unknown, listener: Listen) => {
        options.observe?.(listener);
        return {
          dispose() {
            sessionDisposes += 1;
          },
          refresh: async () => {},
        };
      },
      open: (session: { sessionKey: string }) => {
        opens.push(session.sessionKey);
      },
      create: () => {
        creates += 1;
        return options.create ? options.create() : Promise.resolve("created-session");
      },
      patch: async () => {},
    },
    agents: {
      rows: [{ id: "guide", kind: "assistant", name: "Guide", identity: { name: "Guide" } }],
      selectedId: null,
      defaultId: null,
      scopeId: null,
      select: () => {},
      setScope: () => {},
      refresh: async () => {},
    },
    navigation: {
      openPage: () => {},
      pageHref: () => "/family",
    },
    ui: {},
  };
  const view = mountFamilyPage(container, {
    host: host as unknown as ControlUiHost,
    signal: signal.signal,
    props: options.props ?? {},
    presented: true,
    mountDefault: () => () => {},
  } as ControlUiViewContext);
  return {
    document,
    Event,
    container,
    signal,
    view,
    host: host as unknown as ControlUiHost,
    counts: () => ({ requests, creates, opens, sessionDisposes }),
    calls,
    dialogs,
    listeners,
    /** Delivers a Gateway event the way the host does, by its full wire name. */
    fire: (event: string, payload: unknown = {}) => {
      const listener = listeners.get(event);
      assert.ok(listener, `the page should listen for ${event}`);
      listener(payload);
    },
  };
}

function dayTabs(container: ParentNode) {
  return [...container.querySelectorAll<HTMLButtonElement>(".ocfp-day-tab")];
}

function declaredColor(css: string, selector: string): string | undefined {
  for (const block of css.split("}")) {
    const [head, body] = block.split("{");
    if (!head || !body) continue;
    const selectors = head.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    return /color:\s*([^;]+)/.exec(body)?.[1]?.trim();
  }
  return undefined;
}

describe("family page", { concurrency: 1 }, () => {
  test("phone today tab says Today and marks the date", async () => {
    const page = mountPage({});
    await flush();
    const today = page.container.querySelector(".ocfp-day-tab.is-today");
    assert.ok(today);
    assert.equal(today.childNodes[0]?.nodeValue, "Today");
    assert.equal(today.getAttribute("aria-current"), "date");
    const wednesday = dayTabs(page.container).find((tab) => tab !== today);
    assert.ok(wednesday);
    assert.equal(wednesday.getAttribute("aria-current"), null);
    assert.equal(wednesday.childNodes[0]?.nodeValue, "Mon");
  });

  test("day buttons use aria-pressed and days are labelled regions", async () => {
    const page = mountPage({});
    await flush();
    assert.equal(page.container.querySelector("[role='tablist']")?.getAttribute("role") ?? "none", "none");
    assert.equal(page.container.querySelector("[role='tab']")?.getAttribute("role") ?? "none", "none");
    assert.equal(page.container.querySelector("[role='tabpanel']")?.getAttribute("role") ?? "none", "none");
    assert.equal(page.container.querySelectorAll("[role='region']").length, 7);
    const today = page.container.querySelector(".ocfp-day-tab.is-today");
    assert.equal(today?.getAttribute("aria-pressed"), "true");
    const region = page.container.querySelector("#ocfp-day-2026-09-30");
    assert.equal(region?.getAttribute("role"), "region");
    assert.equal(region?.getAttribute("aria-label"), "Wednesday, September 30");
    const event = new page.Event("keydown");
    Object.defineProperty(event, "key", { value: "ArrowRight" });
    today?.dispatchEvent(event);
    const pressed = dayTabs(page.container).find((tab) => tab.getAttribute("aria-pressed") === "true");
    assert.equal(pressed?.querySelector("b")?.textContent, "1");
    assert.equal(today?.getAttribute("aria-pressed"), "false");
  });

  test("light mode mixes a member colour toward ink until it clears 3.1:1", async () => {
    const page = mountPage({ mode: "light" });
    await flush();
    const alex = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    const shared = page.container.querySelector<HTMLElement>("[data-event-id='e-family']");
    assert.equal(alex?.style.getPropertyValue("--ocfp-event"), "oklch(0.6509 0.1212 220.72)");
    assert.equal(shared?.style.getPropertyValue("--ocfp-event"), "var(--family-neutral)");
  });

  test("a dimmed event title uses the muted token", async () => {
    const page = mountPage({});
    await flush();
    const sam = [...page.container.querySelectorAll<HTMLButtonElement>("button.ocfp-chip")].find((chip) => chip.textContent?.startsWith("Sam"));
    assert.ok(sam);
    sam.click();
    const alex = page.container.querySelector("[data-event-id='e-alex']");
    const title = alex?.querySelector(".ocfp-event-title");
    assert.equal(alex?.classList.contains("is-dimmed"), true);
    assert.equal(title?.textContent, "Dentist");
    assert.equal(declaredColor(readFileSync(new URL("./control-ui.css", import.meta.url), "utf8"), ".ocfp-event.is-dimmed .ocfp-event-title"), "var(--muted)");
  });

  test("dark mode keeps a member colour that already clears 3:1", async () => {
    const page = mountPage({ mode: "dark" });
    await flush();
    const alex = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    assert.equal(alex?.style.getPropertyValue("--ocfp-event"), "oklch(0.72 0.14 245)");
  });

  test("missing read access shows the plain sentence and does not load", async () => {
    const page = mountPage({ canRead: false });
    await flush();
    assert.equal(page.container.textContent?.includes("You need read access to see the family week."), true);
    assert.equal([...page.container.querySelectorAll("button")].some((button) => button.textContent === "Try again"), false);
    assert.equal(page.counts().requests, 0);
  });

  test("a failed load names the failure, offers Try again, and shows the raw error", async () => {
    const page = mountPage({ result: new Error("calendar backend down") });
    await flush();
    assert.equal(page.container.querySelector(".ocfp-empty-title")?.textContent, "Couldn't load the week.");
    assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent, "calendar backend down");
    assert.equal([...page.container.querySelectorAll("button")].some((button) => button.textContent === "Try again"), true);
  });

  test("aborting the page signal drops a late week render", async () => {
    let release: (value: unknown) => void = () => {};
    const page = mountPage({
      request: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await flush();
    page.signal.abort();
    release(week());
    await flush();
    assert.equal(page.container.querySelector(".ocfp-title")?.textContent?.includes("September 28") ?? false, false);
    assert.equal(page.container.querySelector(".ocfp-day-tab")?.className ?? "none", "none");
  });

  test("dispose drops a chat open that resolves afterwards", async () => {
    let listener: Listen = () => {};
    let release: (value: string | null) => void = () => {};
    const page = mountPage({
      observe: (next) => {
        listener = next;
        next({ result: { sessions: [] }, loading: false, error: null });
      },
      create: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await flush();
    const button = page.container.querySelector<HTMLButtonElement>("button.ocfp-agent");
    assert.ok(button);
    button.click();
    await flush();
    assert.equal(page.counts().creates, 1);
    page.view?.dispose();
    listener({
      result: { sessions: [{ key: "late-session", agentId: "guide", isMain: true } as never] },
      loading: false,
      error: null,
    });
    release("created-session");
    await flush();
    assert.deepEqual(page.counts().opens, []);
    assert.equal(page.container.querySelector(".ocfp-chat-error"), null);
  });

  test("a session list that never answers times out and re-enables the chat button", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const page = mountPage({});
    await flush();
    const button = page.container.querySelector<HTMLButtonElement>("button.ocfp-agent");
    assert.ok(button);
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(page.container.querySelector(".ocfp-chat-status")?.textContent, "Opening chat…");
    mock.timers.tick(9_999);
    await flush();
    assert.equal(button.disabled, true);
    assert.equal(page.container.querySelector(".ocfp-chat-error"), null);
    mock.timers.tick(1);
    await flush();
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute("aria-busy"), false);
    assert.equal(page.container.querySelector(".ocfp-chat-status"), null);
    assert.equal(page.container.querySelector(".ocfp-chat-error-title")?.textContent, "Couldn't open the chat.");
    assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent, "timed out");
    assert.deepEqual(page.counts().opens, []);
    assert.equal(page.counts().creates, 0);
  });

  test("a session list answer after the timeout does not open a chat or change the error", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    let listener: Listen = () => {};
    const page = mountPage({
      observe: (next) => {
        listener = next;
      },
    });
    await flush();
    const button = page.container.querySelector<HTMLButtonElement>("button.ocfp-agent");
    assert.ok(button);
    button.click();
    mock.timers.tick(10_000);
    await flush();
    assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent, "timed out");
    assert.equal(button.disabled, false);
    listener({
      result: { sessions: [{ key: "late-session", agentId: "guide", isMain: true } as never] },
      loading: false,
      error: null,
    });
    await flush();
    assert.deepEqual(page.counts().opens, []);
    assert.equal(page.counts().creates, 0);
    assert.equal(page.counts().sessionDisposes, 1);
    assert.equal(button.disabled, false);
    assert.equal(page.container.querySelector(".ocfp-chat-error-title")?.textContent, "Couldn't open the chat.");
    assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent, "timed out");
  });

  test("a synchronous observe result settles the lookup once and a later callback does nothing", async () => {
    const finals = [
      {
        first: { result: { sessions: [{ key: "main-session", agentId: "guide", isMain: true } as never] }, loading: false, error: null },
        opens: ["main-session"],
        reason: null,
      },
      {
        first: { result: null, loading: false, error: "session list failed" },
        opens: [],
        reason: "session list failed",
      },
    ] as const;
    for (const final of finals) {
      let listener: Listen = () => {};
      const page = mountPage({
        observe: (next) => {
          listener = next;
          next(final.first);
        },
      });
      await flush();
      const button = page.container.querySelector<HTMLButtonElement>("button.ocfp-agent");
      assert.ok(button);
      button.click();
      await flush();
      assert.deepEqual(page.counts().opens, [...final.opens]);
      assert.equal(page.counts().creates, 0);
      assert.equal(page.counts().sessionDisposes, 1);
      assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent ?? null, final.reason);
      listener({
        result: { sessions: [{ key: "late-session", agentId: "guide", isMain: true } as never] },
        loading: false,
        error: null,
      });
      await flush();
      assert.deepEqual(page.counts().opens, [...final.opens]);
      assert.equal(page.counts().creates, 0);
      assert.equal(page.counts().sessionDisposes, 1);
      assert.equal(page.container.querySelector(".ocfp-muted-reason")?.textContent ?? null, final.reason);
      assert.equal(button.disabled, false);
    }
  });

  test("the phone day list does not repeat the event gap", () => {
    const css = readFileSync(new URL("./control-ui.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@container ocfp (max-width: 760px)"));
    const start = phone.indexOf(".ocfp-day-events {");
    const block = phone.slice(start, phone.indexOf("}", start));
    assert.equal(block.includes("gap"), false);
    assert.equal(phone.includes("nth-child(n + 3)"), false);
    assert.equal(phone.includes("mask-image"), true);
    const disabled = css.slice(css.indexOf(".ocfp-agent:disabled"));
    const disabledBody = disabled.slice(0, disabled.indexOf("}"));
    assert.equal(disabledBody.includes("opacity"), false);
    assert.equal(disabledBody.includes("var(--muted)"), true);
  });

  test("person chips keep focus, dim instead of hiding, and name the owner", async () => {
    const page = mountPage({ mode: "light" });
    await flush();
    assert.equal(page.container.querySelector(".ocfp-filters")?.getAttribute("aria-label"), "Dim events by person");
    const chips = () => [...page.container.querySelectorAll<HTMLButtonElement>("button.ocfp-chip")];
    const everyone = chips().find((chip) => chip.textContent?.startsWith("Everyone"));
    const sam = chips().find((chip) => chip.textContent?.startsWith("Sam"));
    const alexChip = chips().find((chip) => chip.textContent?.startsWith("Alex"));
    assert.equal(everyone?.getAttribute("aria-pressed"), "true");
    assert.equal(sam?.getAttribute("aria-pressed"), "false");
    assert.equal(alexChip?.style.getPropertyValue("--ocfp-chip"), "oklch(0.6509 0.1212 220.72)");
    sam?.click();
    assert.equal(chips().find((chip) => chip.textContent?.startsWith("Sam")), sam);
    assert.equal(sam?.isConnected, true);
    assert.equal(sam?.getAttribute("aria-pressed"), "true");
    assert.equal(everyone?.getAttribute("aria-pressed"), "false");
    const alex = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    const family = page.container.querySelector("[data-event-id='e-family']");
    assert.equal(alex?.querySelector(".ocfp-owner-name")?.textContent, "Alex");
    assert.match(alex?.getAttribute("aria-label") ?? "", /^Dentist, .+, Alex$/);
    assert.equal(family?.querySelector(".ocfp-chip-role")?.textContent, "Family");
    assert.match(family?.getAttribute("aria-label") ?? "", /Family$/);
    alex?.click();
    const dot = page.dialogs[0]?.content.querySelector<HTMLElement>(".ocfp-owner-dot");
    assert.equal(dot?.style.getPropertyValue("--ocfp-dot"), "oklch(0.6509 0.1212 220.72)");
  });

  test("a merged event is one card with every owner's dot, a neutral stripe, and any owner's chip keeps it lit", async () => {
    const payload = week();
    payload.calendars.push({ key: "c1", label: "Sam", kind: "personal", ownerIds: ["sam"] });
    const alexEvent = payload.calendar.status === "ok" ? payload.calendar.data[0] : undefined;
    assert.ok(alexEvent);
    alexEvent.calendarKeys = ["c0", "c1"];
    const page = mountPage({ mode: "light", result: payload });
    await flush();
    const card = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    assert.equal(page.container.querySelectorAll("[data-event-id='e-alex']").length, 1);
    assert.equal(card?.style.getPropertyValue("--ocfp-event"), "var(--family-neutral)");
    assert.equal(card?.querySelector(".ocfp-owner-name")?.textContent, "Alex, Sam");
    assert.equal(card?.querySelectorAll(".ocfp-owner-dot").length, 2);
    assert.match(card?.getAttribute("aria-label") ?? "", /Alex, Sam$/);
    const sam = [...page.container.querySelectorAll<HTMLButtonElement>("button.ocfp-chip")].find((chip) => chip.textContent?.startsWith("Sam"));
    sam?.click();
    assert.equal(page.container.querySelector("[data-event-id='e-alex']")?.classList.contains("is-dimmed"), false);
    page.container.querySelector<HTMLElement>("[data-event-id='e-alex']")?.click();
    const dialog = page.dialogs[0]?.content;
    assert.deepEqual([...(dialog?.querySelectorAll<HTMLElement>(".ocfp-owner-dot") ?? [])].map((dot) => dot.style.getPropertyValue("--ocfp-dot")), [
      "oklch(0.6509 0.1212 220.72)",
      card?.querySelectorAll<HTMLElement>(".ocfp-owner-dot")[1]?.style.getPropertyValue("--ocfp-dot"),
    ]);
  });

  test("a copy from a shared calendar turns a one-owner merged card neutral", async () => {
    const payload = week();
    const alexEvent = payload.calendar.status === "ok" ? payload.calendar.data[0] : undefined;
    assert.ok(alexEvent);
    payload.calendars[1] = { key: "c4", label: "Family", kind: "shared", ownerIds: [] };
    alexEvent.calendarKeys = ["c0", "c4"];
    const page = mountPage({ mode: "light", result: payload });
    await flush();
    const card = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    assert.equal(card?.style.getPropertyValue("--ocfp-event"), "var(--family-neutral)");
    assert.equal(card?.querySelector(".ocfp-owner-name")?.textContent, "Alex");
  });

  test("a named colour still paints the week in light mode", async () => {
    const payload = week();
    const alexMember = payload.members[0];
    assert.ok(alexMember);
    alexMember.color = "blue";
    const page = mountPage({ mode: "light", result: payload });
    await flush();
    assert.equal(page.container.querySelector(".ocfp-title")?.textContent, "Sep 28 – Oct 4");
    const alex = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    assert.equal(alex?.style.getPropertyValue("--ocfp-event"), "blue");
    alexMember.color = "not-a-color";
    const fallback = mountPage({ mode: "light", result: payload });
    await flush();
    assert.equal(fallback.container.querySelector(".ocfp-title")?.textContent, "Sep 28 – Oct 4");
    assert.equal(fallback.container.querySelector<HTMLElement>("[data-event-id='e-alex']")?.style.getPropertyValue("--ocfp-event"), "#211e1a");
  });

  test("previous and next are disabled when the week cannot move", async () => {
    const early = week();
    early.range = { start: "2026-08-03", end: "2026-08-09", timezone: "UTC" };
    const earlyPage = mountPage({ result: early });
    await flush();
    const earlyPrev = earlyPage.container.querySelector<HTMLButtonElement>("[aria-label='Previous week']");
    const earlyNext = earlyPage.container.querySelector("[aria-label='Next week']");
    assert.equal(earlyPrev?.tagName, "BUTTON");
    assert.equal(earlyPrev?.disabled, true);
    assert.equal(earlyNext?.tagName, "A");
    const late = week();
    late.range = { start: "2027-09-27", end: "2027-10-03", timezone: "UTC" };
    const latePage = mountPage({ result: late });
    await flush();
    const latePrev = latePage.container.querySelector("[aria-label='Previous week']");
    const lateNext = latePage.container.querySelector<HTMLButtonElement>("[aria-label='Next week']");
    assert.equal(latePrev?.tagName, "A");
    assert.equal(lateNext?.tagName, "BUTTON");
    assert.equal(lateNext?.disabled, true);
  });

  test("a start clamped to the browser date is reclamped once to the family today", async () => {
    const browser = browserToday();
    const first = boundWeekStart("2020-01-01", browser);
    const second = boundWeekStart("2020-01-01", "2026-09-30");
    const page = mountPage({ props: { start: "2020-01-01" } });
    await flush();
    const weekCalls = page.calls.filter((call) => call[0] === "family.week");
    assert.deepEqual(new Set(weekCalls.map((call) => call[0])), new Set(["family.week"]));
    const starts = weekCalls.map((call) => (call[1] as { start?: string } | undefined)?.start);
    assert.deepEqual(starts, first === second ? [first] : [first, second]);
    assert.equal(page.container.querySelector(".ocfp-title")?.textContent, "Sep 28 – Oct 4");
  });

  test("with no members, one setup state replaces the calendar and weather hints", async () => {
    const empty: WeekPayload = {
      ...week(),
      members: [],
      calendars: [],
      calendar: { status: "unconfigured", hint: "Add a calendar." },
    };
    const page = mountPage({ result: empty });
    await flush();
    const text = page.container.textContent ?? "";
    assert.equal(text.includes("Set up your family"), true);
    assert.equal(text.includes("openclaw family setup"), true);
    assert.equal(text.includes("Connect your family calendars"), false);
    assert.equal(text.includes("Weather is not set up."), false);
    assert.equal(page.container.querySelectorAll(".ocfp-notice").length, 1);
    assert.equal(page.container.querySelector(".ocfp-weather"), null);
    assert.equal(page.container.querySelector(".ocfp-layout")?.classList.contains("is-single"), true);
  });

  test("once members exist, the calendar and weather hints come back", async () => {
    const page = mountPage({ result: { ...week(), calendar: { status: "unconfigured", hint: "Add a calendar." } } });
    await flush();
    const text = page.container.textContent ?? "";
    assert.equal(text.includes("Set up your family"), false);
    assert.equal(text.includes("Connect your family calendars"), true);
    assert.equal(text.includes("Weather is not set up."), true);
  });
});

test("the latest brief is one quiet line at the end of the stack, above the chat strip", async () => {
  let releaseWeek: (value: unknown) => void = () => {};
  const weekGate = new Promise((resolve) => {
    releaseWeek = resolve;
  });
  const waiting = mountPage({
    request: (method) => (method === "family.deliveryStatus" ? Promise.resolve({ line: "Daily brief sent to Alex.", failed: false }) : weekGate),
  });
  await flush();
  assert.equal(waiting.container.querySelector(".ocfp-delivery"), null, "hidden while the week is still loading");
  assert.equal(waiting.container.textContent?.includes("Loading the week"), true);
  releaseWeek(week());
  await flush();
  const line = waiting.container.querySelector<HTMLElement>(".ocfp-delivery");
  const strip = waiting.container.querySelector(".ocfp-chat-strip");
  assert.ok(line);
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.classList.contains("is-failed"), false);
  assert.equal(line.textContent, "Daily brief sent to Alex.");
  assert.equal(line.parentElement?.classList.contains("ocfp-stack"), true);
  assert.equal(line.nextElementSibling, null);
  assert.equal(line.parentElement?.nextElementSibling, strip);
  assert.equal(waiting.container.querySelector(".ocfp-today"), null);
  assert.equal(waiting.container.querySelector<HTMLElement>(".ocfp-stale")?.hidden, true);

  const missed = mountPage({
    request: (method) => Promise.resolve(method === "family.deliveryStatus" ? { line: "Daily brief did not send to Alex.", failed: true } : week()),
  });
  await flush();
  const failedLine = missed.container.querySelector<HTMLElement>(".ocfp-delivery");
  assert.equal(failedLine?.getAttribute("role"), "alert");
  assert.equal(failedLine?.classList.contains("is-failed"), true);
  assert.equal(failedLine?.querySelector("svg")?.getAttribute("aria-hidden"), "true");
  assert.equal(failedLine?.textContent?.includes("Daily brief did not send to Alex."), true);
  assert.equal(failedLine?.textContent?.includes("discord"), false);

  const empty = mountPage({
    request: (method) => Promise.resolve(method === "family.deliveryStatus" ? { line: "No brief has been sent yet.", failed: false } : week()),
  });
  await flush();
  assert.equal(empty.container.querySelector(".ocfp-delivery")?.textContent, "No brief has been sent yet.");

  const unread = mountPage({
    request: (method) => (method === "family.deliveryStatus" ? Promise.reject(new Error("disk")) : Promise.resolve(week())),
  });
  await flush();
  const unreadLine = unread.container.querySelector(".ocfp-delivery");
  assert.equal(unreadLine?.textContent, "Couldn't check the last brief.");
  assert.equal(unreadLine?.textContent?.includes("disk"), false);

  const weekDown = mountPage({
    request: (method) => (method === "family.deliveryStatus" ? Promise.resolve({ line: "Weekly brief sent.", failed: false }) : Promise.reject(new Error("calendar down"))),
  });
  await flush();
  assert.equal(weekDown.container.textContent?.includes("Couldn't load the week."), true);
  assert.equal(weekDown.container.querySelector(".ocfp-delivery")?.textContent, "Weekly brief sent.");

  const denied = mountPage({ canRead: false });
  await flush();
  assert.equal(denied.container.querySelector(".ocfp-delivery"), null);
});

test("the today widget is a second surface and renders only the highlight lines", async () => {
  const widgets: { id: string; label: string }[] = [];
  familyUi.activate({
    ui: {
      registerNavigation() {},
      registerPage() {},
      registerWidget(widget: { id: string; label: string }) {
        widgets.push({ id: widget.id, label: widget.label });
      },
    },
  } as unknown as ControlUiHost);
  assert.deepEqual(widgets, [{ id: "family-today", label: "Today" }]);

  const mountWidget = (page: ReturnType<typeof mountPage>) => {
    const signal = new AbortController();
    mounted.push(signal);
    const holder = page.document.createElement("div");
    const handle = mountTodayWidget(holder, {
      host: page.host,
      signal: signal.signal,
      props: {},
      presented: true,
      mountDefault: () => () => {},
    } as ControlUiViewContext);
    return { holder, signal, handle };
  };

  const page = mountPage({
    request: (method, params) => {
      const action = params as { actionId?: string } | undefined;
      if (method === "plugins.sessionAction" && action?.actionId === "family.today") {
        return Promise.resolve({
          ok: true,
          result: { date: "2026-09-30", highlights: ["⏰ Dentist in 90 min"], exceptions: [{ title: "Secret trip" }] },
        });
      }
      return Promise.resolve(week());
    },
  });
  const shown = mountWidget(page);
  assert.equal(shown.holder.querySelector(".ocfp-today-title")?.textContent, "Today");
  assert.equal(shown.holder.querySelector("[role=status]")?.textContent, "Loading today");
  assert.equal(shown.holder.querySelector(".ocfp-today")?.getAttribute("aria-busy"), "true");
  await flush();
  assert.equal(shown.holder.querySelector(".ocfp-today")?.getAttribute("aria-busy"), null);
  assert.deepEqual(
    [...shown.holder.querySelectorAll(".ocfp-today p")].map((node) => node.textContent),
    ["⏰ Dentist in 90 min"],
  );
  assert.equal(shown.holder.textContent?.includes("Secret trip"), false);
  assert.equal(page.container.querySelector(".ocfp-today"), null);
  shown.signal.abort();
  assert.equal(shown.holder.querySelector(".ocfp-today"), null);

  const quiet = mountWidget(
    mountPage({
      request: (method, params) => {
        const action = params as { actionId?: string } | undefined;
        if (method === "plugins.sessionAction" && action?.actionId === "family.today") {
          return Promise.resolve({ ok: true, result: { date: "2026-09-30", highlights: ["Looks like a quiet day — nothing urgent."], exceptions: [] } });
        }
        return Promise.resolve(week());
      },
    }),
  );
  await flush();
  assert.equal(quiet.holder.querySelector(".ocfp-today p")?.textContent, "Looks like a quiet day — nothing urgent.");
  assert.equal(quiet.holder.querySelector(".ocfp-today p")?.classList.contains("is-muted"), true);
  quiet.signal.abort();

  const broken = mountWidget(
    mountPage({
      request: (method, params) => {
        const action = params as { actionId?: string } | undefined;
        if (method === "plugins.sessionAction" && action?.actionId === "family.today") return Promise.reject(new Error("disk"));
        return Promise.resolve(week());
      },
    }),
  );
  await flush();
  const error = broken.holder.querySelector(".ocfp-today p");
  assert.equal(error?.textContent, "Couldn't load today.");
  assert.equal(error?.getAttribute("role"), "alert");
  assert.equal(broken.holder.textContent?.includes("disk"), false);
  broken.signal.abort();

  const denied = mountWidget(mountPage({ canRead: false }));
  assert.equal(denied.holder.querySelector(".ocfp-today p")?.textContent, "You need read access to see today.");
  denied.signal.abort();
});

test("the weather card says how old the station's reading is", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.equal(observedText("2026-10-04T11:59:30Z", now), "observed just now");
  assert.equal(observedText("2026-10-04T11:48:00Z", now), "observed 12 min ago");
  assert.equal(observedText("2026-10-04T10:15:00Z", now), "observed 1 h 45 min ago");
  assert.equal(observedText("2026-10-04T12:05:00Z", now), "observed just now", "a clock a little behind the station's");
  assert.equal(observedText(undefined, now), "");
  assert.equal(observedText("not a time", now), "");
});

test("the weather card shows the advice line, the first alert, and the reading's age", async () => {
  const observedAt = new Date(Date.now() - 12 * 60_000).toISOString();
  const page = mountPage({
    result: {
      ...week(),
      weather: {
        status: "ok",
        data: {
          stationName: "Halifax",
          observedAt,
          tempC: 14.5,
          condition: "Mostly Cloudy",
          forecast: [],
          sourceUrl: "https://weather.gc.ca/",
          recommendation: { summary: "Mostly Cloudy · 14°C. Bring a light jacket or layer.", clothing: ["light jacket or layer"], alerts: ["Rain likely this evening (6pm) (~61% chance)"], severity: "low" },
        },
      },
    },
  });
  await flush();
  const advice = [...page.container.querySelectorAll(".ocfp-weather-advice")].map((node) => node.textContent);
  assert.deepEqual(advice, ["Mostly Cloudy · 14°C. Bring a light jacket or layer.", "Rain likely this evening (6pm) (~61% chance)"]);
  assert.equal(page.container.querySelector(".ocfp-weather-temp")?.textContent, "14°", "rounded as the advice line rounds it");
  assert.equal(page.container.querySelector(".ocfp-weather .ocfp-source-note")?.textContent, "Environment Canada · observed 12 min ago");
});

test("someone with no calendars of their own gets one notice and blank days", async () => {
  const page = mountPage({ result: { ...week(), calendars: [], calendar: { status: "hidden" } } });
  await flush();
  const text = page.container.textContent ?? "";
  assert.equal(page.container.querySelectorAll(".ocfp-notice").length, 1);
  assert.equal(text.includes("No calendars for you yet"), true);
  assert.equal(text.includes("Ask a parent to share a calendar with you."), true);
  assert.equal(text.includes("Nothing planned"), false);
  assert.equal(text.includes("Connect your family calendars"), false);
  assert.equal(text.includes("Calendar not connected"), false);
  assert.ok(page.container.querySelector(".ocfp-weather"));
});

function browserToday(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

test("the stale line names the day by the family's midnight, not UTC's", () => {
  const timezone = "America/Halifax";
  const clock = {
    time: new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }),
    timezone,
  };
  const lastGood = Date.parse("2026-10-02T23:30:00.000Z"); // Fri 8:30 PM in Halifax
  assert.equal(staleText(lastGood, Date.parse("2026-10-03T02:59:00.000Z"), clock), "Last updated at 8:30 PM", "a new UTC day, still Friday at home");
  assert.equal(staleText(lastGood, Date.parse("2026-10-03T03:01:00.000Z"), clock), "Last updated Fri 8:30 PM");
});

describe("calendar freshness", { concurrency: 1 }, () => {
  const CHANGED = "plugin.oc-family-pack.calendar-changed";
  const CHECKED = "plugin.oc-family-pack.calendar-checked";

  test("calendar-changed refetches the week in place and keeps focus on the same event", async () => {
    let answer = week();
    const page = mountPage({ request: () => Promise.resolve(answer) });
    await flush();
    let active: Element | null = null;
    Object.defineProperty(page.document, "activeElement", { get: () => active, configurable: true });
    const focus = Object.getOwnPropertyDescriptor(globalThis.HTMLElement.prototype, "focus");
    globalThis.HTMLElement.prototype.focus = function (this: HTMLElement) {
      active = this;
    };
    try {
      page.container.querySelector<HTMLElement>("[data-event-id='e-alex']")?.focus();
      answer = week();
      if (answer.calendar.status === "ok") answer.calendar.data[0]!.title = "Dentist (moved)";
      page.fire(CHANGED, { reason: "external", calendarKeys: [], at: "2026-09-30T14:00:00.000Z" });
      await flush();
      assert.equal(page.counts().requests, 3);
      const card = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
      assert.equal(card?.querySelector(".ocfp-event-title")?.textContent, "Dentist (moved)");
      assert.ok(active !== null && active === card, "focus moves to the re-rendered card");
      assert.equal(page.container.querySelector(".ocfp-week-grid")?.classList.contains("is-entering"), false);
    } finally {
      if (focus) Object.defineProperty(globalThis.HTMLElement.prototype, "focus", focus);
    }
  });

  test("the stale line stays hidden while fresh, counts minutes after 6, and shows the clock after an hour", async (t) => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-09-30T13:40:00.000Z") });
    t.after(() => mock.timers.reset());
    const page = mountPage({});
    await flush();
    const line = () => page.container.querySelector<HTMLElement>(".ocfp-stale");
    const shown = () => (line()?.hidden ? "" : (line()?.textContent ?? ""));
    assert.equal(shown(), "");
    mock.timers.tick(6 * 60_000);
    assert.equal(shown(), "", "exactly six minutes is still fresh");
    mock.timers.tick(30_000);
    assert.equal(shown(), "Last updated 6 min ago");
    mock.timers.tick(6 * 60_000);
    assert.equal(shown(), "Last updated 12 min ago");
    page.fire(CHECKED);
    assert.equal(shown(), "", "a successful poll makes the week fresh again");
    mock.timers.tick(60 * 60_000);
    assert.equal(shown(), "Last updated at 1:52 PM");
    mock.timers.tick(9 * 60 * 60_000 + 7 * 60_000);
    assert.equal(shown(), "Last updated at 1:52 PM", "11:59 PM is still the same day");
    mock.timers.tick(60_000);
    assert.equal(shown(), "Last updated Wed 1:52 PM", "after midnight the line names the day");
    assert.doesNotMatch(page.container.textContent ?? "", /error|failed/i);
  });

  test("leaving the page drops both event listeners", async () => {
    const page = mountPage({});
    await flush();
    assert.deepEqual([...page.listeners.keys()].sort(), [CHANGED, CHECKED]);
    page.signal.abort();
    assert.equal(page.listeners.size, 0);
  });
});

describe("editing from the event dialog", { concurrency: 1 }, () => {
  /** A page whose writes wait until the test answers them. */
  function editPage(flags: Partial<Pick<WeekPayload, "canEdit" | "calendarsReadOnly">>) {
    const writes: { payload: Record<string, unknown>; answer: (value: unknown) => void; fail: (error: Error) => void }[] = [];
    const page = mountPage({
      result: { ...week(), ...flags },
      request: (method, params) => {
        if (method !== "plugins.sessionAction") return Promise.resolve({ ...week(), ...flags });
        return new Promise((resolve, reject) => {
          writes.push({ payload: (params as { payload: Record<string, unknown> }).payload, answer: (result) => resolve({ ok: true, result }), fail: reject });
        });
      },
    });
    return { page, writes };
  }
  async function openDentist(page: ReturnType<typeof mountPage>) {
    await flush();
    page.container.querySelector<HTMLElement>("[data-event-id='e-alex']")?.click();
    const dialog = page.dialogs.at(-1)?.content;
    assert.ok(dialog);
    const buttons = () => Object.fromEntries([...dialog.querySelectorAll<HTMLButtonElement>("button")].map((button) => [button.textContent ?? "", button]));
    return { dialog, buttons };
  }

  test("no edit controls without operator.write, and the read-only notice instead of them while the grant is read-only", async () => {
    const guest = await openDentist(editPage({ canEdit: false, calendarsReadOnly: false }).page);
    assert.deepEqual(Object.keys(guest.buttons()).filter((name) => name), []);
    assert.equal(guest.dialog.querySelector("input"), null);
    const readOnly = await openDentist(editPage({ canEdit: true, calendarsReadOnly: true }).page);
    assert.equal(readOnly.dialog.querySelector(".ocfp-dialog-note")?.textContent, READ_ONLY_HERE);
    assert.deepEqual(Object.keys(readOnly.buttons()).filter((name) => name), []);
  });

  test("Delete sends one write with a fresh requestId, no confirm, and both buttons stay disabled until the reply shows inline", async () => {
    const { page, writes } = editPage({ canEdit: true, calendarsReadOnly: false });
    const { dialog, buttons } = await openDentist(page);
    assert.equal(buttons().Save?.disabled, true);
    assert.notEqual(buttons().Save?.parentElement, buttons().Delete?.parentElement);
    buttons().Delete?.click();
    await flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0]!.payload).sort(), ["id", "op", "requestId"]);
    assert.equal(writes[0]!.payload.op, "delete");
    assert.equal(writes[0]!.payload.id, "e-alex");
    assert.match(String(writes[0]!.payload.requestId), /^[0-9a-f]{32}$/);
    assert.deepEqual([buttons().Save?.disabled, buttons().Delete?.disabled], [true, true]);
    buttons().Delete?.click();
    await flush();
    assert.equal(writes.length, 1);
    writes[0]!.answer({ ok: true, message: "Deleted **Dentist** from Alex's calendar. It was Wednesday September 30 at 1:30 PM." });
    await flush();
    const status = dialog.querySelector(".ocfp-dialog-status");
    assert.equal(status?.textContent, "Deleted Dentist from Alex's calendar. It was Wednesday September 30 at 1:30 PM.");
    assert.equal(status?.querySelector("strong")?.textContent, "Dentist");
    assert.equal(buttons().Delete?.disabled, false);
  });

  test("Save sends only what changed, and a failed request shows ux's line instead of the host's text", async () => {
    const { page, writes } = editPage({ canEdit: true, calendarsReadOnly: false });
    const { dialog, buttons } = await openDentist(page);
    const title = dialog.querySelector<HTMLInputElement>("input[aria-label='Title']");
    assert.ok(title);
    title.value = "Dentist (Sam)";
    title.dispatchEvent(new page.Event("input"));
    assert.equal(buttons().Save?.disabled, false);
    buttons().Save?.click();
    await flush();
    assert.deepEqual({ ...writes[0]!.payload, requestId: "x" }, { op: "update", title: "Dentist (Sam)", id: "e-alex", requestId: "x" });
    writes[0]!.fail(new Error("tool execution failed: SQLITE_IOERR"));
    await flush();
    assert.equal(dialog.querySelector(".ocfp-dialog-status")?.textContent, "Something went wrong checking that, so I didn't change Dentist.");
    buttons().Save?.click();
    await flush();
    assert.notEqual(writes[1]?.payload.requestId, writes[0]?.payload.requestId);
  });
});
