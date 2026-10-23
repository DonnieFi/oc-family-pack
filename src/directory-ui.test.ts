import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { DIRECTORY_METHOD, DIRECTORY_PREVIEW_METHOD } from "./directory-contract.ts";
import { mountPeoplePage } from "./directory-ui.ts";

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
  assert.match(page.container.textContent ?? "", /cannot see emails, phone numbers, or devices/);
  assert.equal((page.container.textContent ?? "").includes("riley@example.com"), false);
  assert.equal((page.container.textContent ?? "").includes("192.168.1.40"), false);
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
