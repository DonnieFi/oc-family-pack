import assert from "node:assert/strict";
import { test } from "node:test";
import { contactAuthority, familyContact } from "./contact.ts";
import { parseConfig } from "./config.ts";
import { planDirectoryEdit, planMaterialize } from "./directory.ts";
import { directoryMethod, directoryPreviewMethod } from "./directory-method.ts";
import { PATCH_INTRO, planSetup } from "./setup.ts";
import { visibleCalendarIds } from "./visibility.ts";
import type { Config } from "./types.ts";

const READY = { status: "ready", command: "", message: "" } as const;
const PHONE = "+1 902 555 0100";
const MAC = "aa:bb:cc:dd:ee:10";

function host(members: unknown[], calendars: unknown[] = []) {
  return { plugins: { entries: { "oc-family-pack": { config: { timezone: "UTC", members, calendars } } } } };
}

function patchMembers(text: string): Record<string, unknown>[] {
  const start = text.indexOf(`${PATCH_INTRO}\n`);
  assert.notEqual(start, -1, text);
  const body = text.slice(start + PATCH_INTRO.length + 1);
  const parsed = JSON.parse(body.slice(0, body.indexOf("\n}\n") + 2)) as {
    plugins: { entries: { "oc-family-pack": { config: { members: Record<string, unknown>[] } } } };
  };
  return parsed.plugins.entries["oc-family-pack"].config.members;
}

test("an omitted id follows the login, and an explicit id does not follow a login or a name change", () => {
  const derived = parseConfig({ members: [{ profileId: "riley-login", name: "Riley", role: "kid" }] });
  assert.equal(derived.members[0]?.id, "riley-login");
  const renamed = parseConfig({ members: [{ profileId: "riley-home", name: "Riley Morgan", role: "kid" }] });
  assert.equal(renamed.members[0]?.id, "riley-home");

  const stable = parseConfig({ members: [{ id: "person-riley", profileId: "riley-login", name: "Riley", role: "kid" }] });
  const moved = parseConfig({ members: [{ id: "person-riley", login: "riley-home", name: "Riley Morgan", role: "kid" }] });
  assert.equal(stable.members[0]?.id, "person-riley");
  assert.equal(stable.members[0]?.profileId, "riley-login");
  assert.equal(moved.members[0]?.id, "person-riley");
  assert.equal(moved.members[0]?.profileId, "riley-home");
  assert.equal(moved.members[0]?.displayName, "Riley Morgan");
});

test("login is an alias of profileId, and the two cannot disagree", () => {
  const config = parseConfig({ members: [{ name: "Riley", login: "Riley-Login", role: "kid" }] });
  assert.equal(config.members[0]?.profileId, "riley-login");
  assert.equal(config.members[0]?.id, "riley-login");
  assert.throws(() => parseConfig({ members: [{ name: "Riley", login: "riley-login", profileId: "other" }] }), /login and profileId don't match/);
});

test("materialize writes the ids already in use and a later login change keeps them", () => {
  const members = [
    { profileId: "alex", displayName: "Alex", role: "parent", devices: [{ label: "Phone", primaryMac: "AA:BB:CC:DD:EE:01", source: "operator" }] },
    { id: "person-riley", profileId: "riley-login", name: "Riley", role: "kid" },
  ];
  const calendars = [{ id: "family", label: "Family", kind: "shared", owners: ["alex", "person-riley"] }];
  const preview = planMaterialize(members, calendars);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.changed, true);
  const materialized = preview.members as Record<string, unknown>[];
  assert.equal(materialized[0]?.id, "alex");
  assert.equal((materialized[0]?.devices as { id: string; primaryMac: string }[])[0]?.id, "phone");
  assert.equal((materialized[0]?.devices as { primaryMac: string }[])[0]?.primaryMac, "AA:BB:CC:DD:EE:01");
  assert.equal(materialized[1]?.id, "person-riley");
  const loaded = parseConfig({ members: preview.members, calendars });
  assert.deepEqual(loaded.calendars[0]?.owners, ["alex", "person-riley"]);

  const edited = planDirectoryEdit(preview.members, [{ id: "person-riley", login: "riley-home" }], calendars);
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  const next = parseConfig({ members: edited.members, calendars });
  assert.equal(next.members[1]?.id, "person-riley");
  assert.equal(next.members[1]?.profileId, "riley-home");
  assert.deepEqual(next.calendars[0]?.owners, ["alex", "person-riley"]);
  assert.equal(edited.patch.includes("riley-login"), false);
});

test("setup updates a person by canonical id when the login is different, and refuses an ambiguous name", () => {
  const updated = planSetup(
    host([{ id: "person-riley", profileId: "riley-login", name: "Riley", role: "kid" }]),
    { email: ["person-riley=riley@example.com"] },
    READY,
    "UTC",
  );
  const members = patchMembers(updated.text);
  assert.equal(members[0]?.id, "person-riley");
  assert.equal(members[0]?.profileId, "riley-login");
  assert.equal(members[0]?.email, "riley@example.com");
  assert.equal(updated.text.slice(0, updated.text.indexOf(PATCH_INTRO)).includes("riley@example.com"), false);

  const ambiguous = planSetup(
    host([
      { id: "person-riley", name: "Riley", role: "kid" },
      { id: "person-sam", name: "Riley", role: "parent" },
    ]),
    { email: ["riley=riley@example.com"] },
    READY,
    "UTC",
  );
  assert.match(ambiguous.text, /`riley` matches more than one person/);
  assert.equal(ambiguous.text.includes("riley@example.com"), false);
  assert.equal(ambiguous.text.includes(PATCH_INTRO), false);
});

test("a migration preview writes missing ids and leaves a roster that already has them", () => {
  const preview = planSetup(
    host(
      [{ profileId: "alex", displayName: "Alex", role: "parent" }],
      [{ id: "family", label: "Family", kind: "shared", owners: ["alex"] }],
    ),
    { materializeIds: true },
    READY,
    "UTC",
  );
  const members = patchMembers(preview.text);
  assert.equal(members[0]?.id, "alex");
  assert.match(preview.text, /changing a name or a login does not change a member id/);
  assert.equal(preview.text.includes('"owners"'), false);

  const done = planSetup(host([{ id: "alex", profileId: "alex", name: "Alex", role: "parent" }]), { materializeIds: true }, READY, "UTC");
  assert.match(done.text, /already has an id/);
  assert.equal(done.text.includes(PATCH_INTRO), false);
});

test("devices keep an explicit id, reject a second copy of a MAC, and store a reservation without observing one", () => {
  const shared = parseConfig({
    members: [
      {
        id: "alex",
        name: "Alex",
        role: "parent",
        devices: [
          {
            id: "tablet",
            label: "Kitchen tablet",
            hostname: "tablet",
            primaryMac: MAC,
            source: "operator",
            sharedWith: ["sam"],
            reservation: { address: "192.168.1.40", network: "lan", source: "operator" },
          },
        ],
      },
      { id: "sam", name: "Sam", role: "parent" },
    ],
  });
  assert.equal(shared.members[0]?.devices[0]?.id, "tablet");
  assert.equal(shared.members[0]?.devices[0]?.hostname, "tablet");
  assert.deepEqual(shared.members[0]?.devices[0]?.reservation, { address: "192.168.1.40", network: "lan", source: "operator" });
  assert.deepEqual(shared.members[0]?.devices[0]?.sharedWith, ["sam"]);
  const relabeled = parseConfig({
    members: [{ id: "alex", name: "Alex", role: "parent", devices: [{ id: "tablet", label: "Den tablet", primaryMac: MAC, source: "operator" }] }],
  });
  assert.equal(relabeled.members[0]?.devices[0]?.id, "tablet");

  assert.throws(
    () =>
      parseConfig({
        members: [
          { id: "alex", name: "Alex", role: "parent", devices: [{ id: "alex-phone", label: "Phone", primaryMac: MAC, source: "operator" }] },
          { id: "sam", name: "Sam", role: "parent", devices: [{ id: "sam-phone", label: "Handset", primaryMac: "AA-BB-CC-DD-EE-10", source: "operator" }] },
        ],
      }),
    /same MAC/,
  );
  assert.throws(
    () =>
      parseConfig({
        members: [
          { id: "alex", name: "Alex", role: "parent", devices: [{ id: "phone", label: "Phone", primaryMac: MAC, source: "operator" }] },
          { id: "sam", name: "Sam", role: "parent", devices: [{ id: "phone", label: "Phone", primaryMac: "aa:bb:cc:dd:ee:11", source: "operator" }] },
        ],
      }),
    /device id phone/,
  );
  assert.throws(
    () =>
      parseConfig({
        members: [{ id: "alex", name: "Alex", role: "parent", devices: [{ label: "Phone", primaryMac: MAC, source: "operator", observedAddress: "10.0.0.8" }] }],
      }),
    /observed address is not stored/,
  );
  assert.throws(
    () =>
      parseConfig({
        members: [
          {
            id: "alex",
            name: "Alex",
            role: "parent",
            devices: [{ label: "Phone", primaryMac: MAC, source: "operator", reservation: { address: "not-an-ip", source: "operator" } }],
          },
        ],
      }),
    (error: Error) => {
      assert.match(error.message, /reserved address must be an IPv4 address/);
      assert.equal(error.message.includes("not-an-ip"), false);
      return true;
    },
  );
});

test("a gateway profile id matches only the host profile, and a login remains the fallback", () => {
  const config = parseConfig({
    members: [
      { id: "person-alex", profileId: "alex", gatewayProfileId: "profile-alex", name: "Alex", role: "parent" },
      { id: "person-riley", name: "Riley", role: "kid" },
    ],
    calendars: [
      { id: "family", label: "Family", kind: "shared", owners: [] },
      { id: "alex", label: "Alex", kind: "personal", owners: ["person-alex"] },
    ],
  });
  assert.deepEqual(
    [...visibleCalendarIds(config, { kind: "person", username: "someone-else", gatewayProfileId: "profile-alex" })].sort(),
    ["alex", "family"],
  );
  assert.deepEqual([...visibleCalendarIds(config, { kind: "person", username: "alex" })].sort(), ["alex", "family"]);
  assert.deepEqual([...visibleCalendarIds(config, { kind: "person", username: "person-alex" })], ["family"]);
  assert.deepEqual([...visibleCalendarIds(config, { kind: "person", username: "alex@example.com" })], ["family"]);
  const ambiguous = {
    members: [
      { ...config.members[0]!, gatewayProfileId: "profile-alex" },
      { ...config.members[1]!, gatewayProfileId: "profile-alex", role: "parent" as const },
    ],
    calendars: config.calendars,
  } satisfies Pick<Config, "members" | "calendars">;
  assert.deepEqual([...visibleCalendarIds(ambiguous, { kind: "person", username: "alex", gatewayProfileId: "profile-alex" })], ["family"]);
});

test("family_contact trusts senderIsOwner and ignores conversationReadOrigin", async () => {
  assert.equal(contactAuthority({ senderIsOwner: true, conversationReadOrigin: "delegated" }), true);
  assert.equal(contactAuthority({ senderIsOwner: false, conversationReadOrigin: "direct-operator" }), false);
  assert.equal(contactAuthority({ conversationReadOrigin: "direct-operator" }), false);
  const config = parseConfig({
    members: [
      {
        id: "alex",
        name: "Alex",
        role: "parent",
        email: "alex@example.com",
        phone: PHONE,
        devices: [{ id: "phone", label: "Phone", primaryMac: MAC, source: "operator", reservation: { address: "192.168.1.40", source: "operator" } }],
      },
    ],
  });
  const refused = await familyContact(config, { senderIsOwner: false }).execute("call", { id: "alex" });
  assert.equal(refused.details.status, "refused");
  assert.equal(JSON.stringify(refused).includes("alex@example.com"), false);
  assert.equal(JSON.stringify(refused).includes(PHONE), false);
  assert.equal(JSON.stringify(refused).includes(MAC), false);
  const card = JSON.parse((await familyContact(config, { senderIsOwner: true }).execute("call", { id: "alex" })).content[0]!.text) as {
    phone?: string;
    devices?: { id: string; label: string; primaryMac?: string }[];
  };
  assert.equal(card.phone, PHONE);
  assert.deepEqual(card.devices, [{ id: "phone", label: "Phone" }]);
  assert.equal(JSON.stringify(card).includes(MAC), false);
  assert.equal(JSON.stringify(card).includes("192.168.1.40"), false);
});

test("the directory methods return the roster to a parent and a preview that does not write", async () => {
  const raw = {
    members: [{ id: "person-riley", profileId: "riley-login", name: "Riley", role: "kid", email: "riley@example.com" }],
    calendars: [{ id: "family", label: "Family", kind: "shared", owners: ["person-riley"] }],
  };
  const config = parseConfig(raw);
  const seen: unknown[] = [];
  const respond = (ok: boolean, payload?: unknown) => {
    seen.push(ok ? payload : "bad");
  };
  await directoryMethod(() => config, () => raw)({ respond });
  const body = seen[0] as { members: { id: string; login?: string; email?: string }[]; persistence: string };
  assert.equal(body.members[0]?.id, "person-riley");
  assert.equal(body.members[0]?.login, "riley-login");
  assert.equal(body.members[0]?.email, "riley@example.com");
  assert.match(body.persistence, /does not write the Gateway config/);

  seen.length = 0;
  await directoryPreviewMethod(() => config, () => raw)({ params: { op: "edit", edits: [{ id: "person-riley", login: "riley-home" }] }, respond });
  const preview = seen[0] as { ok: boolean; patch: string };
  assert.equal(preview.ok, true);
  assert.match(preview.patch, /"id": "person-riley"/);
  assert.match(preview.patch, /"profileId": "riley-home"/);
  assert.equal(preview.patch.includes("192.168"), false);

  seen.length = 0;
  const demo = parseConfig({ demo: true, timezone: "UTC" });
  await directoryPreviewMethod(() => demo, () => raw)({ params: { op: "edit", edits: [{ id: "alex", login: "alex-home" }] }, respond });
  assert.match(JSON.stringify(seen[0]), /Turn demo off/);
});


test("legacy device labels migrate without collisions, data loss, or order dependence", () => {
  const members = [
    { name: "Alex", profileId: "alex", devices: [
      { label: "Phone", primaryMac: "AA-BB-CC-DD-EE-02", source: "operator" },
      { label: "Phone", primaryMac: "aa:bb:cc:dd:ee:01", source: "operator" },
      { label: "Tablet", primaryMac: "aa:bb:cc:dd:ee:03", source: "operator" },
    ] },
    { name: "Sam", id: "person-sam", devices: [
      { label: "Phone", primaryMac: "aa:bb:cc:dd:ee:04", source: "operator", sharedWith: ["alex"] },
      { id: "alex-phone", label: "Explicit", primaryMac: "aa:bb:cc:dd:ee:05", source: "operator" },
    ] },
  ];
  const original = structuredClone(members);
  const ids = (raw: unknown[]) => Object.fromEntries(parseConfig({ members: raw }).members.flatMap(member => member.devices.map(d => [d.primaryMac, d.id])));
  const before = ids(members);
  assert.deepEqual(Object.values(before).sort(), ["alex-phone", "alex-phone-2", "alex-phone-3", "person-sam-phone", "tablet"]);
  assert.deepEqual(ids(members.toReversed().map(m => ({ ...m, devices: m.devices.toReversed() }))), before);
  const migration = planMaterialize(members);
  assert.equal(migration.ok, true);
  if (!migration.ok) return;
  assert.deepEqual(ids(migration.members), before);
  assert.deepEqual(members, original, "preview must not mutate input");
  assert.deepEqual((migration.members as typeof members)[0]?.devices[0]?.primaryMac, "AA-BB-CC-DD-EE-02");
  const again = planMaterialize(migration.members);
  assert.equal(again.ok && again.changed, false);
  const renamed = structuredClone(migration.members) as typeof members;
  renamed[0]!.name = "Alex Morgan";
  renamed[0]!.profileId = "new-login";
  renamed[0]!.devices[0]!.label = "New phone label";
  assert.deepEqual(ids(renamed), before);
});

test("reservations accept only strict IPv4 literals, never IPv6 or malformed addresses", () => {
  const config = (address: string) => ({ members: [{ name: "Alex", devices: [{ label: "Phone", primaryMac: MAC, source: "operator", reservation: { address, source: "operator" } }] }] });
  for (const address of ["192.168.1.40", "0.0.0.0", "255.255.255.255"]) {
    assert.equal(parseConfig(config(address)).members[0]?.devices[0]?.reservation?.address, address);
  }
  for (const address of [":::", "1:2:3", "2001:db8::1", "2001:db8:0:0:0:0:0::", "::ffff:192.168.1.40", "256.1.1.1", "192.168.001.40", "192.168.1", "phone.lan", "192.168.1.40/24"]) {
    assert.throws(() => parseConfig(config(address)), /must be an IPv4 address/, address);
  }
});
