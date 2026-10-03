import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import { baseKey, checkKey, createEvent, END_BEFORE_START, normalizeCreate, type CreateRequest, type WriteDeps, writeScope } from "./calendar-write.ts";
import type { FamilyStore } from "./store.ts";

const DIST_STORE = new URL("../dist/store.js", import.meta.url);
type OpenStore = (options: { stateDir: string }) => Promise<FamilyStore>;

let home = "";
let previousHome: string | undefined;
let gogPath = "";

before(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "ocfp-write-home-"));
  process.env.HOME = home;
  // Nothing lives here. Only the stand-in below answers, so no real gog can run.
  gogPath = join(home, "bin", "gog");
});

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

type FakeEvent = {
  id: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  status: "confirmed" | "cancelled";
  private: Record<string, string>;
};

const VALUE_FLAGS = new Set(["--send-updates", "--max"]);
const BOOL_FLAGS = new Set(["--all-day", "--all-pages", "--json", "--no-input"]);
const REPEATED = new Set(["--private-prop"]);

/** Reads argv the way gog's parser does: `--name=value`, a short list of two-element flags, then `--` and one id. */
function parseArgs(args: string[]): { command: string; flags: Map<string, string[]>; id: string } {
  const command = `${args[0]} ${args[1]}`;
  const dash = args.indexOf("--");
  assert.equal(dash, args.length - 2, `-- must sit just before the one calendar id: ${JSON.stringify(args)}`);
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    if (flags.has(name) && !REPEATED.has(name)) throw new Error(`flag ${name} given twice`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };
  for (let index = 2; index < dash; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) throw new Error(`stray argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      add(arg.slice(0, eq), arg.slice(eq + 1));
    } else if (VALUE_FLAGS.has(arg)) {
      index += 1;
      add(arg, args[index] ?? "");
    } else if (BOOL_FLAGS.has(arg)) {
      add(arg, "true");
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return { command, flags, id: args[dash + 1] ?? "" };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

/** `listsCancelled` stands in for a list that includes deleted events, as Google's showDeleted does. */
function fakeGog({ listsCancelled = false } = {}) {
  const events: FakeEvent[] = [];
  const calls: string[][] = [];
  let onCreate: (() => Promise<void>) | undefined;
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const run: RunGog = async (file, args) => {
    assert.equal(file, gogPath);
    calls.push(args);
    const { command, flags, id } = parseArgs(args);
    await yieldTurn();
    if (command === "calendar events") {
      const filter = one(flags, "--private-prop-filter") ?? "";
      const eq = filter.indexOf("=");
      const from = Date.parse(one(flags, "--from") ?? "");
      const to = Date.parse(one(flags, "--to") ?? "");
      const found = events.filter(
        (event) =>
          event.calendarId === id &&
          (listsCancelled || event.status !== "cancelled") &&
          event.private[filter.slice(0, eq)] === filter.slice(eq + 1) &&
          Date.parse(event.start) < to &&
          Date.parse(event.end) > from,
      );
      return { stdout: JSON.stringify({ events: found.map(resource) }) };
    }
    if (command === "calendar create") {
      assert.equal(one(flags, "--send-updates"), "none");
      const props: Record<string, string> = {};
      for (const prop of flags.get("--private-prop") ?? []) {
        const eq = prop.indexOf("=");
        props[prop.slice(0, eq)] = prop.slice(eq + 1);
      }
      const event: FakeEvent = {
        id: `ev${events.length + 1}`,
        calendarId: id,
        summary: one(flags, "--summary") ?? "",
        start: one(flags, "--from") ?? "",
        end: one(flags, "--to") ?? "",
        allDay: flags.has("--all-day"),
        status: "confirmed",
        private: props,
      };
      const location = one(flags, "--location");
      const description = one(flags, "--description");
      if (location !== undefined) event.location = location;
      if (description !== undefined) event.description = description;
      events.push(event);
      await yieldTurn();
      const hook = onCreate;
      onCreate = undefined;
      if (hook) await hook();
      return { stdout: JSON.stringify({ event: resource(event) }) };
    }
    throw new Error(`the stand-in gog has no ${command}`);
  };
  return {
    run,
    events,
    calls,
    live: () => events.filter((event) => event.status !== "cancelled"),
    remove: (eventId: string) => {
      const event = events.find((entry) => entry.id === eventId);
      if (event) event.status = "cancelled";
    },
    afterNextCreate: (hook: () => Promise<void>) => {
      onCreate = hook;
    },
  };
}

function resource(event: FakeEvent): Record<string, unknown> {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    start: event.allDay ? { date: event.start } : { dateTime: event.start },
    end: event.allDay ? { date: event.end } : { dateTime: event.end },
    extendedProperties: { private: event.private },
  };
}

function dbPath(stateDir: string): string {
  return join(stateDir, "plugins", "oc-family-pack", "oc-family-pack.sqlite");
}

function sqlite(stateDir: string, sql: string): { status: number | null; rows: unknown; stderr: string } {
  const script = `import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.DB);
    const statement = db.prepare(process.env.SQL);
    const rows = /^\s*select/i.test(process.env.SQL) ? statement.all() : statement.run();
    db.close();
    process.stdout.write(JSON.stringify(rows));`;
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    env: { ...process.env, DB: dbPath(stateDir), SQL: sql },
    encoding: "utf8",
  });
  return { status: result.status, rows: result.status === 0 ? JSON.parse(result.stdout) : undefined, stderr: result.stderr };
}

type LogRow = { key: string; base_key: string; status: string; event_id: string | null; op: string; requester: string; calendar_id: string };

function logRows(stateDir: string): LogRow[] {
  const result = sqlite(stateDir, "SELECT request_key AS key, base_key, status, event_id, op, requester, calendar_id FROM oc_family_pack_write_log ORDER BY id");
  assert.equal(result.status, 0, result.stderr);
  return result.rows as LogRow[];
}

async function withStore(run: (ctx: { stateDir: string; store: FamilyStore; open: OpenStore }) => Promise<void>): Promise<void> {
  const { openFamilyStore } = (await import(DIST_STORE.href)) as { openFamilyStore: OpenStore };
  const stateDir = mkdtempSync(join(tmpdir(), "ocfp-write-state-"));
  const store = await openFamilyStore({ stateDir });
  try {
    await run({ stateDir, store, open: openFamilyStore });
  } finally {
    await store.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function deps(gog: ReturnType<typeof fakeGog>, log: WriteDeps["log"]): WriteDeps {
  return { config: { gogPath, timezone: "America/Halifax" }, runGog: gog.run, log };
}

let scopeCounter = 0;
function dentist(overrides: Partial<CreateRequest> = {}): CreateRequest {
  scopeCounter += 1;
  return {
    requester: "discord:britta",
    scope: `agent:main:discord:channel:${scopeCounter}`,
    calendarId: "family@group.calendar.google.com",
    fields: { title: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T14:00:00Z" },
    ...overrides,
  };
}

test("the same create twice makes one event and one committed row", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const request = dentist();
    const first = await createEvent(deps(gog, store), request);
    const second = await createEvent(deps(gog, store), request);
    assert.equal(first.status, "created");
    assert.equal(second.status, "existing");
    assert.equal(second.eventId, first.eventId);
    assert.equal(gog.events.length, 1);
    const rows = logRows(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "committed");
    assert.equal(rows[0]?.event_id, first.eventId);
    assert.equal(rows[0]?.key, `${rows[0]?.base_key}.0`);
    assert.equal(gog.events[0]?.private.ocfpBase, rows[0]?.base_key);
    assert.equal(gog.events[0]?.private.ocfpKey, rows[0]?.key);
  });
});

test("a crash after gog created the event but before the log row leaves one event and one committed row after the retry", async () => {
  await withStore(async ({ stateDir, store, open }) => {
    const gog = fakeGog();
    const request = dentist();
    // The store worker goes away between gog's success and the log write.
    gog.afterNextCreate(() => store.stop());
    await assert.rejects(createEvent(deps(gog, store), request), /stopp/);
    assert.equal(gog.events.length, 1);
    assert.deepEqual(logRows(stateDir), []);

    const restarted = await open({ stateDir });
    try {
      const retry = await createEvent(deps(gog, restarted), request);
      assert.equal(retry.status, "existing");
      assert.equal(retry.eventId, gog.events[0]?.id);
      assert.equal(gog.events.length, 1);
      const rows = logRows(stateDir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "committed");
      assert.equal(rows[0]?.key, gog.events[0]?.private.ocfpKey);
      // A second retry finds the row and adds nothing.
      await createEvent(deps(gog, restarted), request);
      assert.equal(logRows(stateDir).length, 1);
    } finally {
      await restarted.stop();
    }
  });
});

test("add, delete in Google, add again makes a second event under the next request key", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const request = dentist();
    const first = await createEvent(deps(gog, store), request);
    gog.remove(first.eventId);
    const again = await createEvent(deps(gog, store), request);
    assert.equal(again.status, "created");
    assert.notEqual(again.eventId, first.eventId);
    assert.equal(gog.live().length, 1);
    const rows = logRows(stateDir);
    assert.deepEqual(
      rows.map((row) => [row.status, row.key.slice(-2), row.event_id]),
      [
        ["committed", ".0", first.eventId],
        ["committed", ".1", again.eventId],
      ],
    );
    assert.equal(rows[0]?.base_key, rows[1]?.base_key);
  });
});

test("a deleted event that still comes back in the list is not treated as live", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog({ listsCancelled: true });
    const request = dentist();
    const first = await createEvent(deps(gog, store), request);
    gog.remove(first.eventId);
    const again = await createEvent(deps(gog, store), request);
    assert.equal(again.status, "created");
    assert.equal(gog.live().length, 1);
  });
});

test("a live event whose ocfpKey is not under this request's base logs the computed key", async () => {
  await withStore(async ({ stateDir, store, open }) => {
    const gog = fakeGog();
    const request = dentist();
    gog.afterNextCreate(async () => {
      const event = gog.events[0];
      if (event) event.private.ocfpKey = "someone-else.0";
      await store.stop();
    });
    await assert.rejects(createEvent(deps(gog, store), request), /stopp/);
    const restarted = await open({ stateDir });
    try {
      const retry = await createEvent(deps(gog, restarted), request);
      assert.equal(retry.status, "existing");
      const rows = logRows(stateDir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.key, `${rows[0]?.base_key}.0`);
    } finally {
      await restarted.stop();
    }
  });
});

test("the log keeps only summary, start, end, allDay and location", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    await createEvent(
      deps(gog, store),
      dentist({ fields: { title: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T14:00:00Z", location: "Spring Garden", description: "bring the card" } }),
    );
    const result = sqlite(stateDir, "SELECT after_json, before_json FROM oc_family_pack_write_log");
    assert.equal(result.status, 0, result.stderr);
    const [row] = result.rows as { after_json: string; before_json: string | null }[];
    assert.deepEqual(JSON.parse(row?.after_json ?? "null"), {
      summary: "Dentist",
      start: "2026-10-14T13:00:00.000Z",
      end: "2026-10-14T14:00:00.000Z",
      allDay: false,
      location: "Spring Garden",
    });
    assert.equal(row?.before_json, null);
  });
});

test("a committed row already under the key when gog has just created fails loudly instead of being ignored", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    gog.afterNextCreate(async () => {
      const key = gog.events[0]?.private.ocfpKey ?? "";
      const base = gog.events[0]?.private.ocfpBase ?? "";
      const planted = sqlite(
        stateDir,
        `INSERT INTO oc_family_pack_write_log (request_key, base_key, requester, op, calendar_id, status, at) VALUES ('${key}', '${base}', 'page', 'create', 'c', 'committed', 1)`,
      );
      assert.equal(planted.status, 0, planted.stderr);
    });
    await assert.rejects(createEvent(deps(gog, store), dentist()), /UNIQUE/);
  });
});

test("an end at or before the start is refused with ux's line before gog runs", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    const cases: CreateRequest["fields"][] = [
      { title: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T13:00:00Z" },
      { title: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T12:00:00Z" },
      { title: "PD day", start: "2026-10-23", end: "2026-10-23", allDay: true },
      { title: "PD day", start: "2026-10-23", end: "2026-10-22", allDay: true },
    ];
    for (const fields of cases) {
      await assert.rejects(createEvent(deps(gog, store), dentist({ fields })), { message: END_BEFORE_START });
    }
    assert.equal(END_BEFORE_START, "The end has to be after the start. Nothing was added.");
    assert.deepEqual(gog.calls, []);
  });
});

test("a scope with a newline is refused before gog runs", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    await assert.rejects(createEvent(deps(gog, store), dentist({ scope: "submit-1\nsubmit-2" })), /newline/);
    await assert.rejects(createEvent(deps(gog, store), dentist({ scope: "x".repeat(257) })), /256/);
    assert.deepEqual(gog.calls, []);
  });
});

test("two identical creates at once make one event and one committed row", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const request = dentist();
    const results = await Promise.all([createEvent(deps(gog, store), request), createEvent(deps(gog, store), request)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
    assert.equal(results[0]?.eventId, results[1]?.eventId);
    assert.equal(gog.events.length, 1);
    assert.equal(logRows(stateDir).length, 1);
  });
});

test("a different session is a different request and gets its own event", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const first = dentist();
    await createEvent(deps(gog, store), first);
    await createEvent(deps(gog, store), { ...first, scope: `${first.scope}:other` });
    assert.equal(gog.live().length, 2);
    assert.equal(new Set(logRows(stateDir).map((row) => row.base_key)).size, 2);
  });
});

test("each piece of user text is one argv element and -- only precedes the calendar id", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    const title = "--all-day --summary=gotcha";
    const location = "-- rm -rf /";
    const description = "line one\n--send-updates all";
    await createEvent(deps(gog, store), dentist({ fields: { title, start: "2026-10-20T13:00:00Z", end: "2026-10-20T14:00:00Z", location, description } }));
    const [lookup, create, ...rest] = gog.calls;
    assert.equal(rest.length, 0);
    const base = create?.find((arg) => arg.startsWith("--private-prop=ocfpBase="))?.slice("--private-prop=ocfpBase=".length) ?? "";
    assert.deepEqual(lookup, [
      "calendar",
      "events",
      "--from=2026-10-19T13:00:00.000Z",
      "--to=2026-10-21T14:00:00.000Z",
      `--private-prop-filter=ocfpBase=${base}`,
      "--all-pages",
      "--max",
      "250",
      "--json",
      "--no-input",
      "--",
      "family@group.calendar.google.com",
    ]);
    assert.equal(lookup?.some((arg) => /^(create|update|delete|--send-updates)$/.test(arg)), false);
    assert.deepEqual(create, [
      "calendar",
      "create",
      `--summary=${title}`,
      "--from=2026-10-20T13:00:00.000Z",
      "--to=2026-10-20T14:00:00.000Z",
      "--timezone=America/Halifax",
      `--location=${location}`,
      `--description=${description}`,
      "--send-updates",
      "none",
      `--private-prop=ocfpBase=${base}`,
      `--private-prop=ocfpKey=${base}.0`,
      "--json",
      "--no-input",
      "--",
      "family@group.calendar.google.com",
    ]);
    const event = gog.events[0];
    assert.equal(event?.summary, title);
    assert.equal(event?.location, location);
    assert.equal(event?.description, description);
    assert.equal(event?.allDay, false);
  });
});

test("an all-day create looks a day either side and passes --all-day without a timezone", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    await createEvent(deps(gog, store), dentist({ fields: { title: "PD day", start: "2026-10-23", end: "2026-10-24", allDay: true } }));
    const lookup = gog.calls.find((args) => args[1] === "events") ?? [];
    assert.ok(lookup.includes("--from=2026-10-22"));
    assert.ok(lookup.includes("--to=2026-10-25"));
    const create = gog.calls.find((args) => args[1] === "create") ?? [];
    assert.ok(create.includes("--all-day"));
    assert.equal(create.some((arg) => arg.startsWith("--timezone=")), false);
  });
});

test("an all-day create with no end is one day long and the same request as an explicit next-day end", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const request = dentist({ fields: { title: "PD day", start: "2026-10-23", allDay: true } });
    await createEvent(deps(gog, store), request);
    const create = gog.calls.find((args) => args[1] === "create") ?? [];
    assert.ok(create.includes("--to=2026-10-24"));
    const again = await createEvent(deps(gog, store), { ...request, fields: { ...request.fields, end: "2026-10-24" } });
    assert.equal(again.status, "existing");
    assert.equal(gog.calls.filter((args) => args[1] === "create").length, 1);
    assert.equal(logRows(stateDir).length, 1);
    assert.throws(() => normalizeCreate({ title: "Dentist", start: "2026-10-14T13:00:00Z" }), /needs an end/);
  });
});

test("a gog failure logs a failed row and the retry still uses request key .0", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    let fail = true;
    const flaky: RunGog = async (file, args) => {
      if (args[1] === "create" && fail) {
        fail = false;
        throw Object.assign(new Error("gog exited 1"), { code: 1 });
      }
      return gog.run(file, args);
    };
    const request = dentist();
    await assert.rejects(createEvent({ ...deps(gog, store), runGog: flaky }, request), /gog exited 1/);
    const result = await createEvent({ ...deps(gog, store), runGog: flaky }, request);
    assert.equal(result.status, "created");
    const rows = logRows(stateDir);
    assert.deepEqual(rows.map((row) => row.status), ["failed", "committed"]);
    assert.equal(rows[0]?.key, rows[1]?.key);
    assert.equal(rows[1]?.key.endsWith(".0"), true);
  });
});

test("the write log is append-only and a committed key can only be written once", async () => {
  await withStore(async ({ stateDir, store }) => {
    const row = { requestKey: "k.0", baseKey: "k", requester: "page", op: "create" as const, calendarId: "c", eventId: "e1", status: "committed" as const };
    assert.deepEqual(await store.appendWriteLog(row, { ifAbsent: false }), { inserted: true });
    assert.deepEqual(await store.appendWriteLog(row, { ifAbsent: true }), { inserted: false });
    await assert.rejects(store.appendWriteLog(row, { ifAbsent: false }), /UNIQUE/);
    assert.equal(await store.countCommittedWrites("k"), 1);
    const update = sqlite(stateDir, "UPDATE oc_family_pack_write_log SET status = 'reverted'");
    assert.notEqual(update.status, 0);
    assert.match(update.stderr, /append-only/);
    const remove = sqlite(stateDir, "DELETE FROM oc_family_pack_write_log");
    assert.notEqual(remove.status, 0);
    assert.match(remove.stderr, /append-only/);
    await assert.rejects(store.appendWriteLog({ ...row, requestKey: "k.1", status: "draft" as never }, { ifAbsent: false }), /CHECK/);
    await assert.rejects(store.appendWriteLog({ ...row, requestKey: "k.2", op: "rename" as never }, { ifAbsent: false }), /CHECK/);
    // STRICT: a text `at` is refused rather than stored.
    const loose = sqlite(stateDir, "INSERT INTO oc_family_pack_write_log (request_key, base_key, requester, op, calendar_id, status, at) VALUES ('k.3', 'k', 'page', 'create', 'c', 'failed', 'soon')");
    assert.notEqual(loose.status, 0);
    assert.match(loose.stderr, /cannot store TEXT value in INTEGER column/);
    assert.equal(logRows(stateDir).length, 1);
  });
});

test("keys keep Bernie's shape checks: not blank, at most 256 characters, no newline", () => {
  assert.throws(() => checkKey(""), /blank/);
  assert.throws(() => checkKey("   "), /blank/);
  assert.throws(() => checkKey("a".repeat(257)), /256/);
  assert.equal(checkKey("a".repeat(256)).length, 256);
  assert.throws(() => checkKey("a\nb"), /newline/);
  assert.throws(() => checkKey("a\rb"), /newline/);
});

test("the base key ignores spacing and instant format but not content", () => {
  const parts = { requester: "page", op: "create" as const, calendarId: "c", scope: "s" };
  const a = normalizeCreate({ title: " Dentist ", start: "2026-10-14T10:00:00-03:00", end: "2026-10-14T11:00:00-03:00", location: "" });
  const b = normalizeCreate({ title: "Dentist", start: "2026-10-14T13:00:00.000Z", end: "2026-10-14T14:00:00Z" });
  assert.equal(baseKey({ ...parts, fields: a }), baseKey({ ...parts, fields: b }));
  assert.notEqual(baseKey({ ...parts, fields: a }), baseKey({ ...parts, fields: { ...b, title: "Dentist (Penny)" } }));
  assert.notEqual(baseKey({ ...parts, fields: a }), baseKey({ ...parts, scope: "s2", fields: a }));
  assert.throws(() => normalizeCreate({ title: "x", start: "2026-10-14", end: "2026-10-15" }), /date and time/);
  assert.throws(() => normalizeCreate({ title: "x", start: "2026-10-14T10:00:00Z", end: "2026-10-15", allDay: true }), /needs a date/);
});

test("the retry scope is the session key for a tool and the per-submit requestId for the page, never the tool call id", () => {
  const tool = (sessionKey?: string) =>
    ({
      source: "tool",
      toolCallId: "call-1",
      tool: sessionKey === undefined ? {} : { sessionKey },
    }) as unknown as FeatureInvocationContext;
  assert.equal(writeScope(tool("agent:main:discord:channel:1")), "agent:main:discord:channel:1");
  assert.equal(writeScope(tool()), undefined);
  assert.equal(writeScope(tool("  ")), undefined);
  const page = { source: "session-action", action: { pluginId: "p", actionId: "a", sessionKey: "agent:main:main" } } as unknown as FeatureInvocationContext;
  assert.equal(writeScope(page, { requestId: "submit-1" }), "submit-1");
  // No requestId means no write; the session key is never the fallback.
  assert.equal(writeScope(page), undefined);
  assert.equal(writeScope(page, {}), undefined);
  assert.equal(writeScope(page, { requestId: " " }), undefined);
  assert.equal(writeScope(page, { requestId: 7 }), undefined);
  assert.equal(writeScope({ source: "command" } as unknown as FeatureInvocationContext), undefined);
});

test("no real gog is reachable from the tests", () => {
  assert.equal(existsSync(gogPath), false);
  assert.equal(process.env.HOME, home);
});
