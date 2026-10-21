import assert from "node:assert/strict";
import { test } from "node:test";
import { todayHomeMethod } from "./today-home-method.ts";
import { homeSessionKey, seededFlag, todayHomeDecision, todayOnHome, todayPutParams, widgetsOf, TODAY_KIND } from "./today-home.ts";

const onHome = [{ name: "family-today", pluginKind: TODAY_KIND }];

test("Today is placed once, then a missing card is a prompt only for someone who can write", () => {
  assert.equal(todayHomeDecision({ canWrite: true, seeded: false, widgets: [] }), "place");
  assert.equal(todayHomeDecision({ canWrite: true, seeded: false, widgets: onHome }), "ready");
  assert.equal(todayHomeDecision({ canWrite: true, seeded: true, widgets: [] }), "prompt");
  assert.equal(todayHomeDecision({ canWrite: false, seeded: false, widgets: [] }), "ready");
  assert.equal(todayHomeDecision({ canWrite: false, seeded: true, widgets: [] }), "ready");
  assert.equal(todayOnHome([{ pluginKind: TODAY_KIND }]), true);
  assert.equal(todayOnHome([{ name: "notes" }]), false);
});

test("the Home session is the default agent's main session, and the pin is the family Today widget", () => {
  assert.equal(homeSessionKey(null), "agent:main:main");
  assert.equal(homeSessionKey("  "), "agent:main:main");
  assert.equal(homeSessionKey("guide"), "agent:guide:main");
  assert.deepEqual(todayPutParams("agent:main:main"), {
    sessionKey: "agent:main:main",
    name: "family-today",
    title: "Today",
    content: { kind: "plugin", pluginKind: TODAY_KIND },
    placement: { size: "md" },
  });
});

test("a week payload is not a seed read and not a board", () => {
  const week = { mode: "demo", days: [], members: [] };
  assert.equal(seededFlag(week), undefined);
  assert.equal(seededFlag({ seeded: true }), true);
  assert.equal(seededFlag({ seeded: "yes" }), undefined);
  assert.equal(widgetsOf(week), undefined);
  assert.deepEqual(widgetsOf({ widgets: [{ name: "family-today" }], tabs: [{ widgets: [{ content: { pluginKind: TODAY_KIND } }] }] }), [
    { name: "family-today", pluginKind: undefined },
    { name: undefined, pluginKind: TODAY_KIND },
  ]);
});

test("the seed method claims once and does not claim when the store is closed", async () => {
  let seeded = false;
  let claims = 0;
  const method = todayHomeMethod(() => ({
    homeSeeded: async () => seeded,
    claimHomeSeed: async () => {
      claims += 1;
      seeded = true;
      return { inserted: claims === 1 };
    },
  }));
  const answers: unknown[] = [];
  const respond = (_ok: boolean, payload?: unknown) => {
    answers.push(payload);
  };
  await method({ params: {}, respond });
  await method({ params: { claim: true }, respond });
  await method({ params: { claim: true }, respond });
  assert.deepEqual(answers, [{ seeded: false }, { seeded: true }, { seeded: true }]);
  assert.equal(claims, 2);
  const closed = todayHomeMethod(() => undefined);
  const closedAnswers: unknown[] = [];
  await closed({ params: { claim: true }, respond: (_ok, payload) => closedAnswers.push(payload) });
  assert.deepEqual(closedAnswers, [{ seeded: false }]);
  let refused = false;
  await method({
    params: { claim: "yes" },
    respond: (ok) => {
      refused = ok === false;
    },
  });
  assert.equal(refused, true);
  assert.equal(claims, 2);
});
