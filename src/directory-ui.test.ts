import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { DIRECTORY_METHOD, DIRECTORY_PREVIEW_METHOD } from "./directory-contract.ts";
import { mountPeoplePage, onlineProfileIds } from "./directory-ui.ts";

const mounted: AbortController[] = [];
afterEach(() => {
  for (const controller of mounted.splice(0)) controller.abort();
});

const RILEY = {
  id: "person-riley",
  displayName: "Riley",
  role: "kid",
  login: "riley-login",
  email: "riley@example.com",
  phone: "+1 902 555 0100",
  reminders: "dm",
  devices: [
    {
      id: "tablet",
      label: "Tablet",
      hostname: "tablet",
      primaryMac: "aa:bb:cc:dd:ee:10",
      aliasMacs: [],
      source: "operator",
      reservation: { address: "192.168.1.40", source: "operator" },
      sharedWith: [],
    },
  ],
};

function mount(canWrite: boolean, request: (method: string, params: unknown) => Promise<unknown>) {
  const window = parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const signal = new AbortController();
  mounted.push(signal);
  const calls: unknown[][] = [];
  const host = {
    connection: { connected: true, canRead: true, canWrite, canGrant: false, canAdmin: false, assistantAgentId: null },
    request: (method: string, params: unknown) => {
      calls.push([method, params]);
      return request(method, params);
    },
    subscribe: () => () => {},
  };
  mountPeoplePage(container, { host: host as unknown as ControlUiHost, signal: signal.signal, props: {}, presented: true, mountDefault: () => () => {} } as ControlUiViewContext);
  return { container, calls, document: window.document };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test("a kid does not load contact details", async () => {
  const page = mount(false, async () => {
    throw new Error("the roster was requested");
  });
  await flush();
  assert.equal(page.calls.length, 0);
  assert.match(page.container.textContent ?? "", /cannot see emails, phone numbers, Discord ids, or devices/);
  assert.equal((page.container.textContent ?? "").includes("riley@example.com"), false);
  assert.equal((page.container.textContent ?? "").includes("192.168.1.40"), false);
});

test("discarding a named draft leaves the roster untouched", async () => {
  const page = mount(true, async (method) => {
    assert.equal(method, DIRECTORY_METHOD);
    return { demo: false, members: [RILEY] };
  });
  await flush();
  page.container.querySelector<HTMLButtonElement>(".ocfp-people-add")?.click();
  const name = page.container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  assert.ok(name);
  name.value = "Jordan";
  name.dispatchEvent(new page.document.defaultView!.Event("input"));
  const back = page.container.querySelector<HTMLButtonElement>(".ocfp-people-back");
  assert.equal(back?.textContent, "Discard new person");
  back?.click();
  assert.equal(page.container.querySelectorAll(".ocfp-person").length, 1);
  assert.equal(page.calls.length, 1);
});

test("a parent edits the sample login and previews a patch that keeps the member id", async () => {
  const page = mount(true, async (method, params) => {
    if (method === DIRECTORY_METHOD) {
      return {
        demo: false,
        persistence: "This preview does not write the Gateway config.",
        delivery: "This version sends reminders and briefs through Discord.",
        reservation: "A reserved address is stored on the device. Saving it does not change the router.",
        members: [RILEY],
      };
    }
    if (method === DIRECTORY_PREVIEW_METHOD) {
      const edit = (params as { edits: { id: string; login: string }[] }).edits[0];
      return {
        ok: true,
        changed: true,
        note: "This preview does not write the Gateway config.",
        patch: `{"id":"${edit?.id}","profileId":"${edit?.login}"}`,
      };
    }
    throw new Error(method);
  });
  await flush();
  const text = page.container.textContent ?? "";
  assert.match(text, /does not write the Gateway config/);
  assert.match(text, /does not change the router/);
  assert.match(text, /through Discord/);
  page.container.querySelector<HTMLButtonElement>(".ocfp-person")?.click();
  const email = page.container.querySelector('input[aria-label="Email"]') as HTMLInputElement;
  const reserved = page.container.querySelector('input[aria-label="Reserved IP"]') as HTMLInputElement;
  assert.equal(email.value, "riley@example.com");
  assert.equal(reserved.value, "192.168.1.40");
  assert.equal(text.includes("aa:bb:cc:dd:ee:10"), false);
  const login = page.container.querySelector('input[aria-label="Login"]') as HTMLInputElement;
  login.value = "riley-home";
  login.dispatchEvent(new page.document.defaultView!.Event("input"));
  const preview = [...page.container.querySelectorAll("button")].find((button) => button.textContent === "Preview patch");
  preview?.dispatchEvent(new page.document.defaultView!.Event("click"));
  await flush();
  const sent = page.calls.find((call) => call[0] === DIRECTORY_PREVIEW_METHOD)?.[1] as { edits: { id: string; login: string }[] };
  assert.equal(sent.edits[0]?.id, "person-riley");
  assert.equal(sent.edits[0]?.login, "riley-home");
  assert.match(page.container.querySelector(".ocfp-patch")?.textContent ?? "", /person-riley/);
  assert.match(page.container.querySelector(".ocfp-patch")?.textContent ?? "", /riley-home/);
});

test("a parent pins Lobsterdex companions on a kid and the patch keeps them", async () => {
  const page = mount(true, async (method) => {
    if (method === DIRECTORY_METHOD) {
      return {
        persistence: "This preview does not write the Gateway config.",
        delivery: "This version sends reminders and briefs through Discord.",
        reservation: "A reserved address is stored on the device. Saving it does not change the router.",
        members: [{ ...RILEY, lobsterPreferences: ["bee", "not-a-lobster"] }],
      };
    }
    if (method === DIRECTORY_PREVIEW_METHOD) return { ok: true, changed: true, note: "This preview does not write the Gateway config.", patch: "{}" };
    throw new Error(method);
  });
  await flush();
  page.container.querySelector<HTMLButtonElement>(".ocfp-person")?.click();
  const banner = page.container.querySelector(".ocfp-profile-banner");
  assert.match(banner?.textContent ?? "", /Riley’s space/);
  assert.match(banner?.textContent ?? "", /Buzz/);
  assert.equal(page.container.querySelector('input[aria-label="Lobster preferences"]'), null);
  const buzz = page.container.querySelector<HTMLButtonElement>('[data-lobster="bee"]');
  const squeaky = page.container.querySelector<HTMLButtonElement>('[data-lobster="balloon"]');
  assert.equal(buzz?.getAttribute("aria-pressed"), "true");
  assert.equal(squeaky?.getAttribute("aria-pressed"), "false");
  assert.match(buzz?.innerHTML ?? "", /#f4c531/);
  assert.match(squeaky?.innerHTML ?? "", /#ff5c8a/);
  squeaky?.click();
  const preview = [...page.container.querySelectorAll("button")].find((button) => button.textContent === "Preview patch");
  preview?.click();
  await flush();
  const sent = page.calls.find((call) => call[0] === DIRECTORY_PREVIEW_METHOD)?.[1] as { edits: { lobsterPreferences: string[] }[] };
  assert.deepEqual(sent.edits[0]?.lobsterPreferences, ["bee", "not-a-lobster", "balloon"]);
  assert.equal(page.container.querySelector('[data-lobster="balloon"]')?.getAttribute("aria-pressed"), "true");
});

test("Save changes sends save: true, disables controls while in flight, and refreshes the edited card", async () => {
  let resolveSave: ((value: unknown) => void) | undefined;
  const page = mount(true, async (method, params) => {
    if (method === DIRECTORY_METHOD) {
      return {
        demo: false,
        persistence: "Save changes writes the roster to the Gateway config.",
        delivery: "This version sends reminders and briefs through Discord.",
        reservation: "A reserved address is stored on the device. Saving it does not change the router.",
        members: [RILEY],
      };
    }
    if (method === DIRECTORY_PREVIEW_METHOD) {
      const body = params as { op: string; save?: boolean; edits: { id: string; displayName: string }[] };
      assert.equal(body.op, "edit");
      assert.equal(body.save, true);
      return await new Promise((resolve) => {
        resolveSave = () =>
          resolve({
            ok: true,
            saved: true,
            changed: true,
            members: [{ ...RILEY, displayName: body.edits[0]?.displayName ?? RILEY.displayName }],
            note: "Saved roster changes to the Gateway config.",
          });
      });
    }
    throw new Error(method);
  });
  await flush();
  page.container.querySelector<HTMLButtonElement>(".ocfp-person")?.click();
  const nameInput = page.container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
  nameInput.value = "Riley Updated";
  nameInput.dispatchEvent(new page.document.defaultView!.Event("input"));
  const save = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save changes");
  const back = page.container.querySelector<HTMLButtonElement>(".ocfp-people-back");
  assert.ok(save);
  save?.click();
  assert.equal(save?.hasAttribute("disabled"), true);
  assert.equal(nameInput.hasAttribute("disabled"), true);
  assert.equal(back?.hasAttribute("disabled"), true);
  resolveSave?.(undefined);
  await flush();
  assert.equal(save?.hasAttribute("disabled"), false);
  const refreshedNameInput = page.container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
  assert.equal(refreshedNameInput.hasAttribute("disabled"), false);
  assert.equal(page.container.querySelector(".ocfp-patch")?.textContent, "Saved roster changes to the Gateway config.");
  assert.match(page.container.querySelector(".ocfp-profile-banner")?.textContent ?? "", /Riley Updated’s space/);
  assert.equal(page.container.querySelector(".ocfp-people-dirty"), null);
});

test("onlineProfileIds extracts only profile-linked presence entries and ignores devices, non-profiles, and invalid data", () => {
  assert.deepEqual(
    [...onlineProfileIds([
      { text: "host", user: { id: "profile-alex", identity: { kind: "profile" } } },
      { text: "owner", user: { id: "gateway-owner", identity: { kind: "profile" } } },
      { text: "device", user: { id: "dev-1", identity: { kind: "device" } } },
      { text: "no-user" },
      { text: "plain-id", user: { id: "profile-riley" } },
    ])],
    ["profile-alex", "profile-riley"],
  );
  assert.deepEqual([...onlineProfileIds(null)], []);
  assert.deepEqual([...onlineProfileIds({ entries: [{ text: "x", user: { id: "profile-sam" } }] })], ["profile-sam"]);
});

test("People shows an accessible green dot only for linked online profiles and fails closed when presence is denied", async () => {
  const alex = { ...RILEY, id: "person-alex", displayName: "Alex", role: "parent" as const, gatewayProfileId: "profile-alex" };
  const riley = { ...RILEY, id: "person-riley", displayName: "Riley", role: "kid" as const, gatewayProfileId: "profile-riley" };
  const sam = { ...RILEY, id: "person-sam", displayName: "Sam", role: "guest" as const };

  const onlinePage = mount(true, async (method) => {
    if (method === DIRECTORY_METHOD) return { members: [alex, riley, sam] };
    if (method === "system-presence") return [{ text: "Alex online", user: { id: "profile-alex", identity: { kind: "profile" } } }];
    throw new Error(method);
  });
  await flush();
  const cards = [...onlinePage.container.querySelectorAll<HTMLButtonElement>(".ocfp-person")];
  assert.equal(cards.length, 3);
  const alexDot = cards[0]?.querySelector(".ocfp-presence-dot");
  assert.ok(alexDot);
  assert.equal(alexDot?.getAttribute("role"), "img");
  assert.equal(alexDot?.getAttribute("aria-label"), "Online");
  assert.equal(cards[1]?.querySelector(".ocfp-presence-dot"), null);
  assert.equal(cards[2]?.querySelector(".ocfp-presence-dot"), null);

  const deniedPage = mount(true, async (method) => {
    if (method === DIRECTORY_METHOD) return { members: [alex] };
    if (method === "system-presence") throw new Error("missing scope");
    throw new Error(method);
  });
  await flush();
  assert.equal(deniedPage.container.querySelector(".ocfp-presence-dot"), null);
});
