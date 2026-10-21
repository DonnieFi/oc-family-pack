import assert from "node:assert/strict";
import { test } from "node:test";
import { briefTick } from "./briefs.ts";
import type { RunGog } from "./calendar-gog.ts";
import { parseConfig } from "./config.ts";
import { familyHandlers, familyWeek } from "./handlers.ts";
import { familyContact } from "./contact.ts";
import { planSetup, NO_CHANNEL } from "./setup.ts";
import { visibleCalendarIds } from "./visibility.ts";
import { weekMethod, type viewerOf } from "./week-method.ts";

// A member is a contact card. Only the name is required. `id` is the internal key, `profileId`
// is the Control UI login and is never derived, `email` is stored. The operator's family_contact
// tool is the one result that includes it. Everything else, including a refusal, leaves it out.

const EMAIL = "riley.morgan@outlook.com";
const TZ = "America/Halifax";
const tool = (fields: Record<string, unknown>) => ({ source: "tool", api: {}, toolCallId: "call-1", tool: fields }) as never;

test("name is the only required field: id comes from profileId, else from the name; role defaults to guest; profileId is never derived", () => {
  const config = parseConfig({
    members: [
      { name: "Alex", profileId: "Alex", role: "parent" },
      { name: "Riley Morgan" },
      { name: "Sam", id: "sammy", role: "kid" },
    ],
  });
  const [alex, riley, sam] = config.members;
  assert.equal(alex!.id, "alex");
  assert.equal(alex!.profileId, "alex");
  assert.equal(riley!.id, "riley-morgan");
  assert.equal(riley!.profileId, undefined);
  assert.equal(riley!.role, "guest");
  assert.equal(riley!.displayName, "Riley Morgan");
  assert.equal(sam!.id, "sammy");
  assert.equal(sam!.profileId, undefined);
  assert.throws(() => parseConfig({ members: [{ role: "kid" }] }), /members\[0\]\.name/);
});

test("email is optional, trimmed and lowercased, shape-checked, and not unique", () => {
  const config = parseConfig({
    members: [
      { name: "Riley", email: "  Riley.Morgan@Outlook.com " },
      { name: "Sam", email: EMAIL },
      { name: "Jordan" },
    ],
  });
  assert.equal(config.members[0]!.email, EMAIL);
  assert.equal(config.members[1]!.email, EMAIL);
  assert.equal(config.members[2]!.email, undefined);
});

test("ux's load errors, none of which repeat an email or a Discord id", () => {
  const bad = "riley.morgan@outlook";
  assert.throws(() => parseConfig({ members: [{ name: "Riley", email: bad }] }), (error: Error) => {
    assert.equal(error.message, "Riley's email doesn't look right. Check it and try again.");
    assert.equal(error.message.includes(bad), false);
    return true;
  });
  assert.throws(() => parseConfig({ members: [{ name: "Riley" }, { name: "Riley S", id: "riley" }] }), {
    message: "Two people would share the ID riley (Riley and Riley S). Give one of them its own id.",
  });
  assert.throws(() => parseConfig({ members: [{ name: "Riley", profileId: "kid1" }, { name: "Sam", profileId: "KID1" }] }), {
    message: "Riley and Sam have the same Control UI login. Each login can belong to only one person.",
  });
  const discord = "100000000000000001";
  assert.throws(() => parseConfig({ members: [{ name: "Riley", discordId: discord }, { name: "Sam", discordId: discord }] }), (error: Error) => {
    assert.equal(error.message, "Riley and Sam have the same Discord account. Each Discord account can belong to only one person.");
    return true;
  });
});

test("gate (b): a 0.2.0 config with displayName and no id loads, and its owners keys don't change", () => {
  const v020 = {
    timezone: TZ,
    members: [
      { profileId: "alex", displayName: "Alex", role: "parent", discordId: "100000000000000001" },
      { profileId: "riley", displayName: "Riley", role: "kid" },
      { profileId: "kid1", displayName: "Riley", role: "kid" },
    ],
    calendars: [
      { id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: ["alex", "riley"] },
      { id: "school", label: "School", kind: "school", owners: ["riley"] },
      { id: "kid1-personal", label: "Kid1", kind: "personal", owners: ["kid1"] },
    ],
  };
  const config = parseConfig(v020);
  assert.deepEqual(
    config.members.map((member) => [member.id, member.profileId, member.displayName, member.role]),
    [
      ["alex", "alex", "Alex", "parent"],
      ["riley", "riley", "Riley", "kid"],
      ["kid1", "kid1", "Riley", "kid"],
    ],
  );
  assert.deepEqual(
    config.calendars.map((calendar) => calendar.owners),
    [["alex", "riley"], ["riley"], ["kid1"]],
  );
});

test("gate (a): family.week matches the signed-in username to profileId only; a member without one, or a browser-sent id, is no one", async () => {
  const config = parseConfig({
    timezone: TZ,
    members: [
      { name: "Alex", profileId: "alex", role: "parent" },
      { name: "Riley", role: "kid" },
    ],
    calendars: [
      { id: "family", label: "Family", kind: "shared", owners: [] },
      { id: "school", label: "School", kind: "school", owners: ["riley"] },
      { id: "alex", label: "Alex", kind: "personal", owners: ["alex"] },
    ],
  });
  assert.equal(config.members[1]!.id, "riley");
  // Riley has an id but no login, so a session signed in as "riley" is not Riley.
  assert.deepEqual([...visibleCalendarIds(config, { kind: "person", username: "riley" })], ["family"]);
  assert.deepEqual([...visibleCalendarIds(config, { kind: "person", username: "alex" })].sort(), ["alex", "family", "school"]);

  const seen: { username?: string | undefined; kind: string }[] = [];
  const method = weekMethod(async (_input, viewer) => {
    seen.push(viewer.kind === "person" ? { kind: "person", username: viewer.username } : { kind: viewer.kind });
    return { calendars: [] } as never;
  });
  type Client = Parameters<typeof viewerOf>[0];
  const anonymous = {} as unknown as Client;
  for (const params of [{ id: "riley" }, { profileId: "alex" }, { member: "alex" }]) {
    await method({ params, client: anonymous, respond: () => {} } as never);
  }
  for (const viewer of seen) assert.deepEqual(viewer, { kind: "person", username: undefined });
});

test("gate (c): an email appears in no output at all, operator results included", async () => {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(original) as (keyof typeof original)[]) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  const outputs: unknown[] = [];
  try {
    const raw = {
      timezone: TZ,
      gogPath: "/fake/gog",
      members: [
        { name: "Alex", profileId: "alex", role: "parent", email: "alex.morgan@outlook.com", discordId: "100000000000000001" },
        { name: "Riley", role: "kid", email: EMAIL },
      ],
      calendars: [{ id: "family", label: "Family", kind: "shared", owners: ["alex", "riley"] }],
      channels: { family: "222222222222222222" },
      summaryChannel: "family",
    };
    const config = parseConfig(raw);
    const runGog: RunGog = async () => ({
      stdout: JSON.stringify({ events: [{ id: "e1", summary: "Swim", start: { dateTime: "2026-10-20T16:00:00-03:00" }, end: { dateTime: "2026-10-20T17:00:00-03:00" } }] }),
    });
    const now = Date.parse("2026-10-20T12:00:00Z");
    const handlers = familyHandlers(config, { now: () => now, runGog, log: (line: string) => lines.push(line) } as never);
    const owner = tool({ senderIsOwner: true });
    outputs.push(handlers["family.members"]());
    outputs.push(await handlers["family.today"]({}, owner));
    outputs.push(await handlers["family.schedule"]({}, owner));
    outputs.push(await handlers["family.schedule"]({ member: "riley" } as never, owner));
    outputs.push(await handlers["family.today"]({}, tool({ messageChannel: "discord", requesterSenderId: "100000000000000001" })));
    const week = familyWeek(config, { now: () => now, runGog, fetchWeather: async () => new Response("", { status: 503 }) } as never);
    outputs.push(await week({}, { kind: "owner" }).catch((error: unknown) => String(error)));
    // Monday 08:00 in Halifax: both the daily and the weekly brief are due on one tick.
    const monday = Date.parse("2026-10-19T11:00:00Z");
    const sent: string[] = [];
    await briefTick(
      {
        config,
        store: () => ({ deliveryDone: async () => false, appendDeliveryLog: async () => {} }) as never,
        deliver: async (_target, messages, key) => {
          sent.push(key);
          outputs.push(messages);
          return { status: "sent", receipt: { messageIds: ["1"], sentAt: monday } };
        },
        agentName: async () => "Hazel",
        readCalendars: async () => ({
          status: "ok",
          data: [{ id: "c0/e1", title: "Swim", start: "2026-10-19T19:00:00.000Z", end: "2026-10-19T20:00:00.000Z", allDay: false, calendarKey: config.calendars[0]!.key }],
          warnings: [],
        }),
        readWeather: async () => undefined,
        garbageTomorrow: async () => undefined,
        log: (line) => lines.push(line),
      },
      monday,
    );
    assert.deepEqual(sent.map((key) => key.split(":")[0]).sort(), ["daily-summary", "weekly-summary"], sent.join(", "));
    const host = { plugins: { entries: { "oc-family-pack": { config: raw } } } };
    outputs.push(planSetup(host, {}, { steps: [] } as never, TZ));
    outputs.push(planSetup(host, { kid: ["jordan"], email: ["jordan=not-an-email"] }, { steps: [] } as never, TZ));
    const ownerCard = await familyContact(config, { senderIsOwner: true }).execute("call", { id: "riley" });
    assert.equal(JSON.parse(ownerCard.content[0]!.text).email, EMAIL);
    const directCard = await familyContact(config, { directOperator: true }).execute("call", { id: "alex" });
    assert.equal(JSON.parse(directCard.content[0]!.text).email, "alex.morgan@outlook.com");
    outputs.push(await familyContact(config, {}).execute("call", { id: "riley" }));
    outputs.push(await familyContact(config, { senderIsOwner: true }).execute("call", { id: "nope" }));
    outputs.push(await familyContact(config, { senderIsOwner: true }).execute("call", { id: EMAIL }));
    for (const bad of [{ name: "Riley", email: "riley.morgan@outlook" }, { name: "Riley", email: `${EMAIL} x` }]) {
      try {
        parseConfig({ members: [bad] });
      } catch (error) {
        outputs.push(String(error));
      }
    }
  } finally {
    Object.assign(console, original);
  }
  const text = JSON.stringify(outputs) + "\n" + lines.join("\n");
  assert.ok(text.length > 100, "the outputs were captured");
  for (const leak of [EMAIL, "alex.morgan@outlook.com", "riley.morgan@outlook", "outlook.com"]) {
    assert.equal(text.includes(leak), false, `${leak} leaked`);
  }
});

test("setup warns, in ux's words, about a member bots can't reach, and says nothing about a missing login", () => {
  const host = (members: unknown[]) => ({ plugins: { entries: { "oc-family-pack": { config: { timezone: TZ, members } } } } });
  const text = planSetup(host([{ name: "Riley", role: "kid" }, { name: "Alex", role: "parent", discordId: "100000000000000001" }, { name: "Sam", email: "sam@example.org" }]), {}, { steps: [] } as never, TZ).text;
  assert.equal(NO_CHANNEL("Riley"), "Riley has no email or Discord, so the bots can't reach them. Add either one to fix this.");
  assert.ok(text.includes(NO_CHANNEL("Riley")), text);
  assert.equal(text.includes(NO_CHANNEL("Alex")), false);
  assert.equal(text.includes(NO_CHANNEL("Sam")), false);
  assert.equal(/Control UI login|profileId/i.test(text), false, text);
});
