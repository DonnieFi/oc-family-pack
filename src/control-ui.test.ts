import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlUiHost, ControlUiSessionListSnapshot, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { mountFamilyPage } from "./control-ui.ts";
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
  };
}

type Listen = (snapshot: ControlUiSessionListSnapshot) => void;

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
  result?: { ok: true; result: WeekPayload } | { ok: false; error: string };
  request?: () => Promise<unknown>;
  observe?: (listener: Listen) => void;
  create?: () => Promise<string | null>;
}) {
  const { document, Event } = installDom(options.mode ?? "dark");
  const container = document.createElement("div");
  document.body.append(container);
  const signal = new AbortController();
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
      if (options.request) return options.request();
      return Promise.resolve(options.result ?? { ok: true, result: week() });
    },
    onEvent: () => () => {},
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
    counts: () => ({ requests, creates, opens, sessionDisposes }),
    calls,
    dialogs,
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
    const page = mountPage({ result: { ok: false, error: "calendar backend down" } });
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
    release({ ok: true, result: week() });
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

  test("a named colour still paints the week in light mode", async () => {
    const payload = week();
    const alexMember = payload.members[0];
    assert.ok(alexMember);
    alexMember.color = "blue";
    const page = mountPage({ mode: "light", result: { ok: true, result: payload } });
    await flush();
    assert.equal(page.container.querySelector(".ocfp-title")?.textContent, "Sep 28 – Oct 4");
    const alex = page.container.querySelector<HTMLElement>("[data-event-id='e-alex']");
    assert.equal(alex?.style.getPropertyValue("--ocfp-event"), "blue");
    alexMember.color = "not-a-color";
    const fallback = mountPage({ mode: "light", result: { ok: true, result: payload } });
    await flush();
    assert.equal(fallback.container.querySelector(".ocfp-title")?.textContent, "Sep 28 – Oct 4");
    assert.equal(fallback.container.querySelector<HTMLElement>("[data-event-id='e-alex']")?.style.getPropertyValue("--ocfp-event"), "#211e1a");
  });

  test("previous and next are disabled when the week cannot move", async () => {
    const early = week();
    early.range = { start: "2026-08-03", end: "2026-08-09", timezone: "UTC" };
    const earlyPage = mountPage({ result: { ok: true, result: early } });
    await flush();
    const earlyPrev = earlyPage.container.querySelector<HTMLButtonElement>("[aria-label='Previous week']");
    const earlyNext = earlyPage.container.querySelector("[aria-label='Next week']");
    assert.equal(earlyPrev?.tagName, "BUTTON");
    assert.equal(earlyPrev?.disabled, true);
    assert.equal(earlyNext?.tagName, "A");
    const late = week();
    late.range = { start: "2027-09-27", end: "2027-10-03", timezone: "UTC" };
    const latePage = mountPage({ result: { ok: true, result: late } });
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
    const starts = page.calls.map((call) => {
      const body = call[1] as { payload?: { start?: string } } | undefined;
      return body?.payload?.start;
    });
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
    const page = mountPage({ result: { ok: true, result: empty } });
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
    const page = mountPage({ result: { ok: true, result: { ...week(), calendar: { status: "unconfigured", hint: "Add a calendar." } } } });
    await flush();
    const text = page.container.textContent ?? "";
    assert.equal(text.includes("Set up your family"), false);
    assert.equal(text.includes("Connect your family calendars"), true);
    assert.equal(text.includes("Weather is not set up."), true);
  });
});

function browserToday(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
