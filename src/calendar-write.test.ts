import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import {
  baseKey,
  changeEvent,
  checkKey,
  createEvent,
  NOTHING_TO_CHANGE,
  normalizeChange,
  somethingWrongLine,
  changedWhileWaitingLine,
  submitChange,
  type ChangeRequest,
  type ChangeResult,
  type SubmitChangeResult,
  type WriteLog,
  END_BEFORE_START,
  END_BEFORE_START_CHANGE,
  normalizeCreate,
  requesterTag,
  submitCreate,
  type CreateRequest,
  type CreateResult,
  type SubmitDeps,
  type WriteDeps,
  writeScope,
} from "./calendar-write.ts";
import { parseConfig } from "./config.ts";
import type { FamilyStore } from "./store.ts";
import type { WriteMode } from "./types.ts";
import { READONLY_GRANT } from "./gog-setup.ts";
import { grantHolder, type Grant, type GrantHolder } from "./grant.ts";
import { READ_ONLY, VIEW_ONLY, WRITES_OFF } from "./write-gate.ts";

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
  recurringEventId?: string;
  originalStart?: string;
  recurrence?: string[];
};

// --send-updates is not here: it must be one `--send-updates=none` element, so the two-element form fails to parse.
const VALUE_FLAGS = new Set(["--max"]);
const BOOL_FLAGS = new Set(["--all-day", "--all-pages", "--json", "--no-input", "--force"]);
/** How many ids each command takes after `--`. */
const POSITIONALS: Record<string, number> = { "calendar events": 1, "calendar create": 1, "calendar event": 2, "calendar update": 2, "calendar delete": 2, "calendar move": 3 };
const REPEATED = new Set(["--private-prop"]);

/** Reads argv the way gog's parser does: `--name=value`, a short list of two-element flags, then `--` and the command's ids. */
function parseArgs(args: string[]): { command: string; flags: Map<string, string[]>; id: string; ids: string[] } {
  const command = `${args[0]} ${args[1]}`;
  const dash = args.indexOf("--");
  assert.equal(dash, args.length - 1 - (POSITIONALS[command] ?? 1), `-- must sit just before the ids: ${JSON.stringify(args)}`);
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
  return { command, flags, id: args[dash + 1] ?? "", ids: args.slice(dash + 1) };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

/**
 * `listsCancelled` stands in for a list that includes deleted events, as Google's showDeleted does.
 * `ignoresFilter` stands in for a gog that drops --private-prop-filter and lists everything in the window.
 */
function fakeGog({ listsCancelled = false, ignoresFilter = false, failCreate }: { listsCancelled?: boolean; ignoresFilter?: boolean; failCreate?: () => Error } = {}) {
  const events: FakeEvent[] = [];
  const calls: string[][] = [];
  let onCreate: (() => Promise<void>) | undefined;
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** A failure for the next calls of one subcommand (event, update, move, delete). */
  const fail = new Map<string, () => Error>();
  const find = (calendarId: string, eventId: string) => events.find((event) => event.id === eventId && event.calendarId === calendarId);
  const run: RunGog = async (file, args) => {
    assert.equal(file, gogPath);
    calls.push(args);
    const { command, flags, id, ids } = parseArgs(args);
    await yieldTurn();
    const failure = fail.get(args[1] ?? "");
    if (failure) throw failure();
    if (command === "calendar event") {
      const event = find(ids[0] ?? "", ids[1] ?? "");
      if (!event) throw gogError("Error: googleapi: Error 404: Not Found, notFound");
      return { stdout: JSON.stringify({ event: resource(event) }) };
    }
    if (command === "calendar update" || command === "calendar move" || command === "calendar delete") {
      assert.equal(one(flags, "--send-updates"), "none");
      const event = find(ids[0] ?? "", ids[1] ?? "");
      if (!event) throw gogError("Error: googleapi: Error 404: Not Found, notFound");
      if (event.status === "cancelled") throw gogError("Error: googleapi: Error 410: Resource has been deleted, deleted");
      if (command === "calendar move") event.calendarId = ids[2] ?? "";
      else if (command === "calendar delete") event.status = "cancelled";
      else {
        const summary = one(flags, "--summary");
        const from = one(flags, "--from");
        const to = one(flags, "--to");
        const location = one(flags, "--location");
        const description = one(flags, "--description");
        if (summary !== undefined) event.summary = summary;
        if (from !== undefined) event.start = from;
        if (to !== undefined) event.end = to;
        if (from !== undefined) event.allDay = flags.has("--all-day");
        if (location !== undefined) event.location = location;
        if (description !== undefined) event.description = description;
      }
      return { stdout: JSON.stringify({ event: resource(event) }) };
    }
    if (command === "calendar events") {
      const filter = one(flags, "--private-prop-filter") ?? "";
      const eq = filter.indexOf("=");
      const from = Date.parse(one(flags, "--from") ?? "");
      const to = Date.parse(one(flags, "--to") ?? "");
      const found = events.filter(
        (event) =>
          event.calendarId === id &&
          (listsCancelled || event.status !== "cancelled") &&
          (ignoresFilter || event.private[filter.slice(0, eq)] === filter.slice(eq + 1)) &&
          Date.parse(event.start) < to &&
          Date.parse(event.end) > from,
      );
      return { stdout: JSON.stringify({ events: found.map(resource) }) };
    }
    if (command === "calendar create") {
      assert.equal(one(flags, "--send-updates"), "none");
      if (failCreate) throw failCreate();
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
    fail,
    writes: () => calls.filter((args) => ["create", "update", "move", "delete"].includes(args[1] ?? "")),
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
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.originalStart ? { originalStartTime: { dateTime: event.originalStart } } : {}),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
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

function deps(gog: ReturnType<typeof fakeGog>, log: WriteDeps["log"], grant: GrantHolder = grantHolder()): WriteDeps {
  return { config: { gogPath, timezone: "America/Halifax" }, runGog: gog.run, log, grant };
}

/** A create that reached Google: its event id, or the test fails. */
function made(result: CreateResult): Extract<CreateResult, { eventId: string }> {
  assert.notEqual(result.status, "failed", JSON.stringify(result));
  return result as Extract<CreateResult, { eventId: string }>;
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

test("a store that stops after gog created the event still answers created, and the retry leaves one event and one committed row", async () => {
  await withStore(async ({ stateDir, store, open }) => {
    const gog = fakeGog();
    const request = dentist();
    // The store worker goes away between gog's success and the log write.
    gog.afterNextCreate(() => store.stop());
    assert.equal((await createEvent(deps(gog, store), request)).status, "created");
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
    const first = made(await createEvent(deps(gog, store), request));
    gog.remove(first.eventId);
    const again = made(await createEvent(deps(gog, store), request));
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
    const first = made(await createEvent(deps(gog, store), request));
    gog.remove(first.eventId);
    const again = made(await createEvent(deps(gog, store), request));
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
    assert.equal((await createEvent(deps(gog, store), request)).status, "created");
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

test("a committed row already under the key when gog has just created: the plain INSERT is refused, no second row lands, the create still answers", async () => {
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
    assert.equal((await createEvent(deps(gog, store), dentist())).status, "created");
    assert.deepEqual(logRows(stateDir).map((row) => [row.op, row.calendar_id]), [["create", "c"]]);
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
    const results = (await Promise.all([createEvent(deps(gog, store), request), createEvent(deps(gog, store), request)])).map(made);
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
      "--send-updates=none",
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

test("a gog failure logs a failed row, returns `unreachable` without throwing, and the retry still uses request key .0", async () => {
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
    assert.deepEqual(await createEvent({ ...deps(gog, store), runGog: flaky }, request), { status: "failed", reason: "unreachable" });
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

test("the write log keeps its committed-key, base and event indexes", async () => {
  await withStore(async ({ stateDir }) => {
    const list = sqlite(stateDir, "SELECT name, \"unique\" AS uniq, partial FROM pragma_index_list('oc_family_pack_write_log') WHERE origin = 'c' ORDER BY name");
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(list.rows, [
      { name: "oc_family_pack_write_log_base", uniq: 0, partial: 0 },
      { name: "oc_family_pack_write_log_committed_key", uniq: 1, partial: 1 },
      { name: "oc_family_pack_write_log_event", uniq: 0, partial: 0 },
    ]);
    const columns = (index: string) => {
      const info = sqlite(stateDir, `SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`);
      assert.equal(info.status, 0, info.stderr);
      return (info.rows as { name: string }[]).map((row) => row.name);
    };
    assert.deepEqual(columns("oc_family_pack_write_log_committed_key"), ["request_key"]);
    assert.deepEqual(columns("oc_family_pack_write_log_base"), ["base_key", "status"]);
    assert.deepEqual(columns("oc_family_pack_write_log_event"), ["calendar_id", "event_id", "at"]);
    const partial = sqlite(stateDir, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'oc_family_pack_write_log_committed_key'");
    assert.equal(partial.status, 0, partial.stderr);
    assert.match((partial.rows as { sql: string }[])[0]?.sql ?? "", /\bWHERE status = 'committed'$/);
  });
});

test("a gog that ignores --private-prop-filter still can't pass off someone else's event as this one", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog({ ignoresFilter: true });
    const request = dentist();
    const other = (id: string, props: Record<string, string>): void => {
      gog.events.push({ id, calendarId: request.calendarId, summary: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T14:00:00Z", allDay: false, status: "confirmed", private: props });
    };
    other("hand-made", {});
    other("someone-else", { ocfpBase: "f".repeat(64), ocfpKey: `${"f".repeat(64)}.0` });
    const result = await createEvent(deps(gog, store), request);
    assert.equal(result.status, "created");
    assert.equal(gog.calls.filter((args) => args[1] === "create").length, 1);
    assert.notEqual(result.eventId, "hand-made");
    assert.notEqual(result.eventId, "someone-else");
    assert.deepEqual(logRows(stateDir).map((row) => [row.event_id, row.status]), [[result.eventId, "committed"]]);
  });
});

const household = parseConfig({
  timezone: "America/Halifax",
  members: [
    { profileId: "britta", displayName: "Britta", role: "parent" },
    { profileId: "calla", displayName: "Calla", role: "kid" },
  ],
  calendars: [{ id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: ["britta", "calla"] }],
});
const FAMILY = household.calendars[0]!;
const PARENT_SCOPES = ["operator.read", "operator.write", "operator.sessions.write"];

function submitDeps(gog: ReturnType<typeof fakeGog>, log: WriteDeps["log"], writes: WriteMode = "on", grant: GrantHolder = grantHolder()): SubmitDeps {
  return { config: { gogPath, timezone: "America/Halifax", writes, members: household.members }, runGog: gog.run, log, grant };
}

let submitCounter = 0;
/** A page submit as the host hands it to a session action: `client` from the connection, `payload` from the browser. */
function pageSubmit(client: unknown, payload: Record<string, unknown> = {}) {
  submitCounter += 1;
  const fullPayload = { requestId: `submit-${submitCounter}`, ...payload };
  const action = { pluginId: "oc-family-pack", actionId: "family.calendar.create", payload: fullPayload, ...(client === undefined ? {} : { client }) };
  return {
    context: { source: "session-action", api: {}, action } as unknown as FeatureInvocationContext,
    payload: fullPayload,
    calendar: FAMILY,
    fields: { title: "Dentist", start: "2026-10-14T13:00:00Z", end: "2026-10-14T14:00:00Z" },
  };
}

const GUEST_CLIENTS: [string, unknown][] = [
  ["operator.read only", { connId: "c1", scopes: ["operator.read"] }],
  ["empty scopes", { connId: "c2", scopes: [] }],
  ["no scopes field", { connId: "c3" }],
  ["no client", undefined],
];

test("gate 0: a page session without a write scope gets the view-only line, no gog call and no log row, in every mode", async () => {
  await withStore(async ({ stateDir, store }) => {
    for (const writes of ["on", "confirm", "off"] as const) {
      for (const [name, client] of GUEST_CLIENTS) {
        const gog = fakeGog();
        const result = await submitCreate(submitDeps(gog, store, writes), pageSubmit(client));
        assert.deepEqual(result, { status: "refused", message: VIEW_ONLY }, `${name}, writes ${writes}`);
        assert.equal(gog.calls.length, 0, `${name}, writes ${writes}`);
      }
    }
    assert.deepEqual(logRows(stateDir), []);
  });
});

test("gate 0 ignores a role or scope the page payload claims", async () => {
  await withStore(async ({ stateDir, store }) => {
    const claims = { role: "parent", scopes: ["operator.write", "operator.admin"], client: { scopes: ["operator.admin"] }, requester: "page:parent" };
    for (const [name, client] of GUEST_CLIENTS) {
      const gog = fakeGog();
      assert.deepEqual(await submitCreate(submitDeps(gog, store), pageSubmit(client, claims)), { status: "refused", message: VIEW_ONLY }, name);
      assert.equal(gog.calls.length, 0, name);
    }
    assert.deepEqual(logRows(stateDir), []);
  });
});

test("writes off refuses a parent's page with the off line, no gog call and no log row", async () => {
  await withStore(async ({ stateDir, store }) => {
    for (const scopes of [PARENT_SCOPES, ["operator.admin"]]) {
      const gog = fakeGog();
      assert.deepEqual(await submitCreate(submitDeps(gog, store, "off"), pageSubmit({ connId: "p", scopes })), { status: "refused", message: WRITES_OFF });
      assert.equal(gog.calls.length, 0);
    }
    assert.deepEqual(logRows(stateDir), []);
  });
});

test("writes confirm holds a parent's page write for approval without touching gog or the log", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    assert.deepEqual(await submitCreate(submitDeps(gog, store, "confirm"), pageSubmit({ connId: "p", scopes: PARENT_SCOPES })), {
      status: "needs-approval",
      approvers: ["Britta"],
    });
    assert.equal(gog.calls.length, 0);
    assert.deepEqual(logRows(stateDir), []);
  });
});

test("a parent's page and an admin-only page write, and every create argv says --send-updates=none", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const parent = await submitCreate(submitDeps(gog, store), pageSubmit({ connId: "p", scopes: PARENT_SCOPES }));
    const admin = await submitCreate(submitDeps(gog, store), pageSubmit({ connId: "a", scopes: ["operator.admin"] }));
    assert.equal(parent.status, "created");
    assert.equal(admin.status, "created");
    await createEvent(deps(gog, store), dentist({ fields: { title: "Swim", start: "2026-10-15", allDay: true } }));
    const creates = gog.calls.filter((args) => args[1] === "create");
    assert.equal(creates.length, 3);
    for (const args of creates) {
      assert.equal(args.filter((arg) => arg.startsWith("--send-updates")).length, 1, JSON.stringify(args));
      assert.ok(args.includes("--send-updates=none"), JSON.stringify(args));
    }
    for (const args of gog.calls.filter((args) => args[1] !== "create")) {
      assert.equal(args.some((arg) => arg.startsWith("--send-updates")), false, JSON.stringify(args));
    }
    assert.deepEqual(
      logRows(stateDir).map((row) => [row.requester, row.status]),
      [
        ["page", "committed"],
        ["page", "committed"],
        ["discord:britta", "committed"],
      ],
    );
  });
});

/** What execFile rejects with: gog's stderr on the error, and a message that repeats the argv. */
function gogError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: gog calendar create --summary=insufficient ACCESS_TOKEN_SCOPE calendar.readonly\n${stderr}`), { code: 1, stderr, ...extra });
}
const READONLY_STDERR = "Error: googleapi: Error 403: Request had insufficient authentication scopes., insufficientPermissions";

test("a read-only grant refuses a parent's write with the read-only line, no gog call and no log row", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    for (const scopes of [PARENT_SCOPES, ["operator.admin"]]) {
      const result = await submitCreate(submitDeps(gog, store, "on", grantHolder("read-only")), pageSubmit({ connId: "p", scopes }));
      assert.deepEqual(result, { status: "refused", message: READ_ONLY });
    }
    assert.deepEqual(await submitCreate(submitDeps(gog, store, "confirm", grantHolder("read-only")), pageSubmit({ connId: "p", scopes: PARENT_SCOPES })), { status: "refused", message: READ_ONLY });
    assert.deepEqual(await submitCreate(submitDeps(gog, store, "off", grantHolder("read-only")), pageSubmit({ connId: "p", scopes: PARENT_SCOPES })), { status: "refused", message: WRITES_OFF });
    assert.deepEqual(await submitCreate(submitDeps(gog, store, "on", grantHolder("read-only")), pageSubmit({ connId: "g", scopes: ["operator.read"] })), { status: "refused", message: VIEW_ONLY });
    assert.equal(gog.calls.length, 0);
    assert.deepEqual(logRows(stateDir), []);
  });
});

test("an unknown grant lets a parent's write through", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    const grant = grantHolder();
    assert.equal(grant.get(), "unknown");
    assert.equal((await submitCreate(submitDeps(gog, store, "on", grant), pageSubmit({ connId: "p", scopes: PARENT_SCOPES }))).status, "created");
    assert.equal(grant.get(), "unknown");
  });
});

test("a gog write that fails with the read-only grant error flips the grant, so the next write is refused before gog", async () => {
  await withStore(async ({ stateDir, store }) => {
    for (const start of ["unknown", "read-write"] as Grant[]) {
      const grant = grantHolder(start);
      const failing = fakeGog({ failCreate: () => gogError(READONLY_STDERR) });
      assert.deepEqual(await submitCreate(submitDeps(failing, store, "on", grant), pageSubmit({ connId: "p", scopes: PARENT_SCOPES })), { status: "failed", reason: "readonly" });
      assert.equal(grant.get(), "read-only", start);
      assert.equal(grant.source(), "write-failure", "flipped through the holder's setter");
      const next = fakeGog();
      assert.deepEqual(await submitCreate(submitDeps(next, store, "on", grant), pageSubmit({ connId: "p", scopes: PARENT_SCOPES })), { status: "refused", message: READ_ONLY });
      assert.equal(next.calls.length, 0);
    }
    // Only the two failed creates left rows; the refusals left none.
    assert.deepEqual(logRows(stateDir).map((row) => row.status), ["failed", "failed"]);
  });
});

test("a timeout, another non-zero exit, or a 500 leaves the grant as it was", async () => {
  await withStore(async ({ store }) => {
    const failures: [string, () => Error][] = [
      ["timeout", () => Object.assign(new Error("Command failed: gog calendar create --summary=insufficient"), { killed: true, signal: "SIGTERM", code: null, stderr: "" })],
      ["other exit", () => gogError("Error: calendar not found: family@group.calendar.google.com")],
      ["500", () => gogError("Error: googleapi: Error 500: Backend Error, backendError")],
      ["no stderr", () => new Error("spawn gog EACCES insufficient ACCESS_TOKEN_SCOPE")],
    ];
    for (const start of ["unknown", "read-write"] as Grant[]) {
      for (const [name, failCreate] of failures) {
        const grant = grantHolder(start);
        const result = await submitCreate(submitDeps(fakeGog({ failCreate }), store, "on", grant), pageSubmit({ connId: "p", scopes: PARENT_SCOPES }));
        assert.deepEqual(result, { status: "failed", reason: "unreachable" }, name);
        assert.equal(grant.get(), start, `${name} from ${start}`);
        assert.equal(grant.source(), "initial", name);
      }
    }
  });
});

/** A write log whose `failed` rows can't be written: the store went away after the gog call. */
function failedRowsThrow() {
  const committed: string[] = [];
  return {
    committed,
    countCommittedWrites: async () => 0,
    committedWrite: async () => undefined,
    appendWriteLog: async (row: { status: string; requestKey: string }) => {
      if (row.status === "failed") throw new Error("oc-family-pack: the family store stopped");
      committed.push(row.requestKey);
      return { inserted: true };
    },
  };
}

test("the grant flips even when the failed row can't be written, and the outcome still comes back", async () => {
  const grant = grantHolder("read-write");
  const log = failedRowsThrow();
  const readonly = await createEvent(deps(fakeGog({ failCreate: () => gogError(READONLY_STDERR) }), log, grant), dentist());
  assert.deepEqual(readonly, { status: "failed", reason: "readonly" });
  assert.equal(grant.get(), "read-only");
  assert.equal(grant.source(), "write-failure");
  const other = grantHolder("read-write");
  const unreachable = await createEvent(deps(fakeGog({ failCreate: () => gogError("Error: googleapi: Error 500: Backend Error") }), failedRowsThrow(), other), dentist());
  assert.deepEqual(unreachable, { status: "failed", reason: "unreachable" });
  assert.equal(other.get(), "read-write");
  assert.equal(other.source(), "initial");
  assert.deepEqual(log.committed, []);
});

test("the write path classifies with the one shared READONLY_GRANT matcher: a phrase added to it is read-only at write time too", async () => {
  const PHRASE = "ocfp-test-new-readonly-phrase";
  const { source, flags } = READONLY_GRANT;
  assert.equal(READONLY_GRANT.test(PHRASE), false);
  // Extend the shared matcher in place, the way a gog wording change would extend it in gog-setup.ts.
  READONLY_GRANT.compile(`${source}|${PHRASE}`, flags);
  try {
    const grant = grantHolder("read-write");
    const result = await createEvent(deps(fakeGog({ failCreate: () => gogError(`Error: ${PHRASE}`) }), failedRowsThrow(), grant), dentist());
    assert.deepEqual(result, { status: "failed", reason: "readonly" });
    assert.equal(grant.get(), "read-only");
    // And narrowed: without the phrase the same failure is `unreachable`.
    READONLY_GRANT.compile(source, flags);
    const other = grantHolder("read-write");
    assert.deepEqual(await createEvent(deps(fakeGog({ failCreate: () => gogError(`Error: ${PHRASE}`) }), failedRowsThrow(), other), dentist()), { status: "failed", reason: "unreachable" });
    assert.equal(other.get(), "read-write");
  } finally {
    READONLY_GRANT.compile(source, flags);
  }
  assert.equal(READONLY_GRANT.test(PHRASE), false);
});

test("no real gog is reachable from the tests", () => {
  assert.equal(existsSync(gogPath), false);
  assert.equal(process.env.HOME, home);
});

test("every off-Discord tool caller is `tool` in the key's requester tag, owner or not", () => {
  assert.equal(requesterTag({ from: "tool", senderIsOwner: true }), "tool");
  assert.equal(requesterTag({ from: "tool", senderIsOwner: false }), "tool");
  assert.equal(requesterTag({ from: "discord", member: household.members[1]! }), "discord:calla");
  assert.equal(requesterTag({ from: "discord" }), "discord:unmatched");
});

// ---- update, move, delete ----

const FAMILY_ID = "family@group.calendar.google.com";
const CALLA_ID = "calla@group.calendar.google.com";

/** An event already in Google, as the change tests start from. */
function seed(gog: ReturnType<typeof fakeGog>, overrides: { [K in keyof FakeEvent]?: FakeEvent[K] | undefined } = {}): FakeEvent {
  const event = {
    id: `seed${gog.events.length + 1}`,
    calendarId: FAMILY_ID,
    summary: "Dentist",
    start: "2026-10-14T13:00:00.000Z",
    end: "2026-10-14T14:00:00.000Z",
    allDay: false,
    location: "Main St",
    status: "confirmed",
    private: {},
    ...overrides,
  } as FakeEvent;
  if (event.location === undefined) delete event.location;
  gog.events.push(event);
  return event;
}

let changeCounter = 0;
function change(op: ChangeRequest["op"], eventId: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  changeCounter += 1;
  return { requester: "discord:britta", scope: `agent:main:discord:channel:change-${changeCounter}`, op, calendarId: FAMILY_ID, eventId, ...overrides };
}

type JsonRow = { key: string; status: string; op: string; event_id: string | null; before_json: string | null; after_json: string | null };
function jsonRows(stateDir: string): JsonRow[] {
  const result = sqlite(stateDir, "SELECT request_key AS key, status, op, event_id, before_json, after_json FROM oc_family_pack_write_log ORDER BY id");
  assert.equal(result.status, 0, result.stderr);
  return result.rows as JsonRow[];
}
const parsed = (json: string | null) => (json === null ? null : (JSON.parse(json) as Record<string, unknown>));

function done(result: ChangeResult | SubmitChangeResult): Extract<ChangeResult, { before: unknown }> {
  assert.ok(result.status === "changed" || result.status === "existing", JSON.stringify(result));
  return result as Extract<ChangeResult, { before: unknown }>;
}

const FIVE = { summary: "Dentist", start: "2026-10-14T13:00:00.000Z", end: "2026-10-14T14:00:00.000Z", allDay: false, location: "Main St" };

test("an update passes only the changed fields, keeps the event's length, and logs the five fields before and after", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog, { description: "Bring the card" });
    const result = done(await changeEvent(deps(gog, store), change("update", event.id, { fields: { start: "2026-10-15T17:00:00Z" } })));
    assert.equal(result.status, "changed");
    assert.deepEqual(result.before, { title: "Dentist", start: FIVE.start, end: FIVE.end, allDay: false, location: "Main St" });
    assert.deepEqual(result.after, { title: "Dentist", start: "2026-10-15T17:00:00.000Z", end: "2026-10-15T18:00:00.000Z", allDay: false, location: "Main St" });
    const [update] = gog.writes();
    assert.deepEqual(update, ["calendar", "update", "--from=2026-10-15T17:00:00.000Z", "--to=2026-10-15T18:00:00.000Z", "--send-updates=none", "--json", "--no-input", "--", FAMILY_ID, event.id]);
    assert.equal(event.description, "Bring the card");
    const rows = jsonRows(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.op, "update");
    assert.equal(rows[0]?.status, "committed");
    assert.equal(rows[0]?.event_id, event.id);
    assert.deepEqual(parsed(rows[0]?.before_json ?? null), FIVE);
    assert.deepEqual(parsed(rows[0]?.after_json ?? null), { ...FIVE, start: "2026-10-15T17:00:00.000Z", end: "2026-10-15T18:00:00.000Z" });
  });
});

test("each op logs its exact key set, and event_id is always set", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const a = seed(gog);
    const b = seed(gog);
    const c = seed(gog);
    done(await changeEvent(deps(gog, store), change("update", a.id, { fields: { title: "Dentist (Calla)" } })));
    done(await changeEvent(deps(gog, store), change("move", b.id, { destinationId: CALLA_ID })));
    done(await changeEvent(deps(gog, store), change("delete", c.id)));
    const rows = jsonRows(stateDir);
    const keys = (json: string | null) => (json === null ? null : Object.keys(JSON.parse(json) as object).sort());
    assert.deepEqual(
      rows.map((row) => [row.op, row.event_id, keys(row.before_json), keys(row.after_json)]),
      [
        ["update", a.id, ["allDay", "end", "location", "start", "summary"], ["allDay", "end", "location", "start", "summary"]],
        ["move", b.id, ["allDay", "end", "location", "start", "summary"], ["calendarId"]],
        ["delete", c.id, ["allDay", "end", "location", "start", "summary"], null],
      ],
    );
    assert.deepEqual(parsed(rows[1]?.after_json ?? null), { calendarId: CALLA_ID });
    assert.equal(gog.events.find((event) => event.id === b.id)?.calendarId, CALLA_ID);
    assert.equal(gog.events.find((event) => event.id === c.id)?.status, "cancelled");
  });
});

test("the same change twice is one gog write and one row; the retry answers from the log without asking gog", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog);
    const request = change("update", event.id, { fields: { title: "Dentist (Calla)" } });
    const first = done(await changeEvent(deps(gog, store), request));
    const calls = gog.calls.length;
    const second = done(await changeEvent(deps(gog, store), request));
    assert.equal(first.status, "changed");
    assert.equal(second.status, "existing");
    assert.deepEqual(second.before, first.before);
    assert.deepEqual(second.after, first.after);
    assert.equal(gog.calls.length, calls);
    assert.equal(jsonRows(stateDir).length, 1);
  });
});

test("an update the event already matches is existing, with no gog write and an INSERT OR IGNORE row", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog);
    const result = done(await changeEvent(deps(gog, store), change("update", event.id, { fields: { title: " Dentist ", location: "Main St" } })));
    assert.equal(result.status, "existing");
    assert.equal(gog.writes().length, 0);
    assert.deepEqual(jsonRows(stateDir).map((row) => row.status), ["committed"]);
  });
});

test("a 404 is not found: no gog write and no row, for every op", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    for (const request of [change("update", "nope", { fields: { title: "X" } }), change("move", "nope", { destinationId: CALLA_ID }), change("delete", "nope")]) {
      assert.deepEqual(await changeEvent(deps(gog, store), request), { status: "not-found" }, request.op);
    }
    assert.equal(gog.writes().length, 0);
    assert.deepEqual(jsonRows(stateDir), []);
  });
});

test("deleting an event Google already deleted: not found with no row when it was gone at the first look, existing once a parent approved it or after a 410 from the delete", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const cancelled = seed(gog, { status: "cancelled" });
    assert.deepEqual(await changeEvent(deps(gog, store), change("delete", cancelled.id)), { status: "not-found", title: "Dentist" });
    assert.deepEqual(jsonRows(stateDir), []);
    const result = done(await changeEvent(deps(gog, store), change("delete", cancelled.id, { approved: { version: '"v1"', title: "Dentist" } })));
    assert.equal(result.status, "existing");
    assert.equal(result.before.title, "Dentist");
    assert.equal(gog.writes().length, 0);
    const racing = seed(gog);
    gog.fail.set("delete", () => gogError("Error: googleapi: Error 410: Resource has been deleted, deleted"));
    assert.equal(done(await changeEvent(deps(gog, store), change("delete", racing.id))).status, "existing");
    const rows = jsonRows(stateDir);
    assert.deepEqual(rows.map((row) => [row.status, row.event_id]), [["committed", cancelled.id], ["committed", racing.id]]);
    // A cancelled event is not found for an update, by its name.
    assert.deepEqual(await changeEvent(deps(gog, store), change("update", cancelled.id, { fields: { title: "X" } })), { status: "not-found", title: "Dentist" });
  });
});

test("a 410 on the read is not found for a delete with nothing to say what it was", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    gog.fail.set("event", () => gogError("Error: googleapi: Error 410: Resource has been deleted, deleted"));
    assert.deepEqual(await changeEvent(deps(gog, store), change("delete", "gone1")), { status: "not-found" });
    assert.deepEqual(jsonRows(stateDir), []);
  });
});

test("a move that already happened is found on the destination and answered as existing", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog, { calendarId: CALLA_ID });
    const result = done(await changeEvent(deps(gog, store), change("move", event.id, { destinationId: CALLA_ID })));
    assert.equal(result.status, "existing");
    assert.equal(gog.writes().length, 0);
    assert.deepEqual(jsonRows(stateDir).map((row) => [row.op, row.status, parsed(row.after_json)]), [["move", "committed", { calendarId: CALLA_ID }]]);
  });
});

test("every change argv says --send-updates=none once and keeps user text in one element", async () => {
  await withStore(async ({ store }) => {
    const gog = fakeGog();
    const a = seed(gog);
    const b = seed(gog);
    const c = seed(gog);
    const title = "--to=2030-01-01 -- x";
    done(await changeEvent(deps(gog, store), change("update", a.id, { fields: { title, location: "-x", description: "line\nline" } })));
    done(await changeEvent(deps(gog, store), change("move", b.id, { destinationId: CALLA_ID })));
    done(await changeEvent(deps(gog, store), change("delete", c.id)));
    const writes = gog.writes();
    assert.equal(writes.length, 3);
    for (const args of writes) assert.equal(args.filter((arg) => arg.startsWith("--send-updates")).join(), "--send-updates=none", JSON.stringify(args));
    assert.ok(writes[0]?.includes(`--summary=${title}`));
    assert.equal(gog.events.find((event) => event.id === a.id)?.summary, title);
    assert.deepEqual(writes[1], ["calendar", "move", "--send-updates=none", "--json", "--no-input", "--", FAMILY_ID, b.id, CALLA_ID]);
    assert.deepEqual(writes[2], ["calendar", "delete", "--send-updates=none", "--force", "--no-input", "--", FAMILY_ID, c.id]);
  });
});

test("a gog failure on a change logs a failed row with the event id; the read-only error flips the grant", async () => {
  await withStore(async ({ stateDir, store }) => {
    for (const op of ["update", "move", "delete"] as const) {
      const gog = fakeGog();
      const event = seed(gog);
      const grant = grantHolder();
      const request = change(op, event.id, { fields: { title: "X" }, destinationId: CALLA_ID });
      gog.fail.set(op, () => gogError("Error: googleapi: Error 500: Backend Error"));
      assert.deepEqual(await changeEvent(deps(gog, store, grant), request), { status: "failed", reason: "unreachable", title: "Dentist" }, op);
      assert.equal(grant.get(), "unknown");
      gog.fail.set(op, () => gogError(READONLY_STDERR));
      assert.deepEqual(await changeEvent(deps(gog, store, grant), request), { status: "failed", reason: "readonly", title: "Dentist" }, op);
      assert.equal(grant.get(), "read-only", op);
    }
    const rows = jsonRows(stateDir);
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.status, "failed");
      assert.ok(row.event_id);
      assert.deepEqual(parsed(row.before_json), FIVE);
    }
  });
});

test("a repeating event's later occurrences go through the series with --scope and --original-start, and the log keeps the recurrence", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    seed(gog, { id: "swim", summary: "Swim", location: undefined, start: "2026-10-06T21:00:00.000Z", end: "2026-10-06T22:00:00.000Z", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE:20261020T210000Z"] });
    seed(gog, { id: "swim_1013", summary: "Swim", location: undefined, start: "2026-10-13T21:00:00.000Z", end: "2026-10-13T22:00:00.000Z", recurringEventId: "swim", originalStart: "2026-10-13T21:00:00.000Z" });
    const future = done(await changeEvent(deps(gog, store), change("update", "swim_1013", { fields: { location: "Pool" }, series: "future" })));
    assert.equal(future.seriesFrom, "2026-10-13T21:00:00.000Z");
    assert.deepEqual(gog.writes()[0], ["calendar", "update", "--location=Pool", "--scope=future", "--original-start=2026-10-13T21:00:00.000Z", "--send-updates=none", "--json", "--no-input", "--", FAMILY_ID, "swim"]);
    const all = done(await changeEvent(deps(gog, store), change("delete", "swim_1013", { series: "all" })));
    assert.equal(all.seriesFrom, "2026-10-06T21:00:00.000Z");
    assert.deepEqual(gog.writes()[1], ["calendar", "delete", "--scope=all", "--send-updates=none", "--force", "--no-input", "--", FAMILY_ID, "swim"]);
    const rows = jsonRows(stateDir);
    const keys = (json: string | null) => (json === null ? null : Object.keys(JSON.parse(json) as object).sort());
    assert.deepEqual(rows.map((row) => [row.op, keys(row.before_json), keys(row.after_json)]), [
      ["update", ["allDay", "end", "recurrence", "seriesStart", "start", "summary"], ["allDay", "end", "location", "originalStart", "scope", "start", "summary"]],
      ["delete", ["allDay", "end", "recurrence", "seriesStart", "start", "summary"], ["originalStart", "scope"]],
    ]);
    assert.deepEqual(parsed(rows[0]?.before_json ?? null)?.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE:20261020T210000Z"]);
    // One occurrence is the instance itself, with no series flags.
    seed(gog, { id: "swim_1027", summary: "Swim", location: undefined, start: "2026-10-27T21:00:00.000Z", end: "2026-10-27T22:00:00.000Z", recurringEventId: "swim", originalStart: "2026-10-27T21:00:00.000Z" });
    const single = done(await changeEvent(deps(gog, store), change("delete", "swim_1027")));
    assert.equal(single.seriesFrom, undefined);
    assert.deepEqual(gog.writes()[2], ["calendar", "delete", "--send-updates=none", "--force", "--no-input", "--", FAMILY_ID, "swim_1027"]);
  });
});

test("an update needs something to change, and an end at or before the start is refused before gog writes", async () => {
  assert.throws(() => normalizeChange({ title: "  " }), new RegExp(NOTHING_TO_CHANGE));
  assert.deepEqual(normalizeChange({ start: "2026-10-15" }), { start: "2026-10-15", allDay: true });
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog);
    assert.deepEqual(await changeEvent(deps(gog, store), change("update", event.id, { fields: { end: "2026-10-14T12:00:00Z" } })), { status: "invalid", message: END_BEFORE_START_CHANGE });
    assert.equal(gog.writes().length, 0);
    assert.deepEqual(jsonRows(stateDir), []);
  });
});

/** A write log that records each append and can be told to fail at one step. */
function recordingLog(failAt: { lookup?: boolean; committed?: boolean } = {}) {
  const appends: { status: string; ifAbsent: boolean }[] = [];
  const stopped = () => new Error("oc-family-pack: the family store stopped: SQLITE_IOERR disk I/O error");
  const log: WriteLog = {
    countCommittedWrites: async () => {
      if (failAt.lookup) throw stopped();
      return 0;
    },
    committedWrite: async () => {
      if (failAt.lookup) throw stopped();
      return undefined;
    },
    appendWriteLog: async (row, { ifAbsent }) => {
      appends.push({ status: row.status, ifAbsent });
      if (failAt.committed && row.status === "committed") throw stopped();
      return { inserted: true };
    },
  };
  return { log, appends };
}

test("store failure before gog: no gog write, a failed row where the store takes one, and the reason is `store`", async () => {
  for (const op of ["create", "update", "move", "delete"] as const) {
    const gog = fakeGog();
    const event = seed(gog);
    const { log, appends } = recordingLog({ lookup: true });
    const result =
      op === "create" ? await createEvent(deps(gog, log), dentist()) : await changeEvent(deps(gog, log), change(op, event.id, { fields: { title: "X" }, destinationId: CALLA_ID }));
    assert.deepEqual(result, { status: "failed", reason: "store", ...(op === "create" ? {} : { title: "Dentist" }) }, op);
    assert.deepEqual(gog.writes(), [], op);
    assert.deepEqual(appends, [{ status: "failed", ifAbsent: false }], op);
  }
  assert.equal(somethingWrongLine("delete", "Dentist"), "Something went wrong checking that, so I didn't delete **Dentist**.");
  assert.equal(somethingWrongLine("move", undefined), "Something went wrong checking that, so I didn't move that event.");
});

test("ux's changed-while-waiting line names the event as approved, or says that event", () => {
  assert.equal(changedWhileWaitingLine("delete", "Dentist"), "**Dentist** was changed while it was waiting for approval, so I didn't delete it. Ask again if you still want to.");
  assert.equal(changedWhileWaitingLine("move", undefined), "That event was changed while it was waiting for approval, so I didn't move it. Ask again if you still want to.");
});

test("store failure after gog wrote: the write still answers as done, and a real write was a plain INSERT", async () => {
  for (const op of ["create", "update", "move", "delete"] as const) {
    const gog = fakeGog();
    const event = seed(gog);
    const { log, appends } = recordingLog({ committed: true });
    const result =
      op === "create" ? await createEvent(deps(gog, log), dentist()) : await changeEvent(deps(gog, log), change(op, event.id, { fields: { title: "X" }, destinationId: CALLA_ID }));
    assert.equal(result.status, op === "create" ? "created" : "changed", op);
    assert.equal(gog.writes().length, 1, op);
    assert.deepEqual(appends, [{ status: "committed", ifAbsent: false }], op);
  }
});

test("a change goes through the same gate: guest page, writes off and read-only are refused before gog, a kid on a shared calendar needs approval", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog);
    const base = { op: "delete" as const, calendar: FAMILY, eventId: event.id };
    const page = (scopes: string[]) => ({ ...pageSubmit({ connId: "p", scopes }), ...base });
    assert.deepEqual(await submitChange(submitDeps(gog, store), page(["operator.read"])), { status: "refused", message: VIEW_ONLY });
    assert.deepEqual(await submitChange(submitDeps(gog, store, "off"), page(PARENT_SCOPES)), { status: "refused", message: WRITES_OFF });
    assert.deepEqual(await submitChange(submitDeps(gog, store, "on", grantHolder("read-only")), page(PARENT_SCOPES)), { status: "refused", message: READ_ONLY });
    const tool = { context: { source: "tool", api: {}, toolCallId: "call-1", tool: { sessionKey: "agent:main:x", senderIsOwner: false, conversationReadOrigin: "direct-operator" } } as unknown as FeatureInvocationContext, ...base };
    assert.deepEqual(await submitChange(submitDeps(gog, store), tool), { status: "needs-approval", approvers: ["Britta"] });
    assert.equal(gog.calls.length, 0);
    assert.deepEqual(logRows(stateDir), []);
    assert.equal(done(await submitChange(submitDeps(gog, store), page(PARENT_SCOPES))).status, "changed");
  });
});

test("two page submits of the same change are two requests: the second finds it already done", async () => {
  await withStore(async ({ stateDir, store }) => {
    const gog = fakeGog();
    const event = seed(gog);
    const submit = () => ({ ...pageSubmit({ connId: "p", scopes: PARENT_SCOPES }), op: "update" as const, calendar: FAMILY, eventId: event.id, fields: { title: "Dentist (Calla)" } });
    assert.equal(done(await submitChange(submitDeps(gog, store), submit())).status, "changed");
    assert.equal(done(await submitChange(submitDeps(gog, store), submit())).status, "existing");
    const rows = jsonRows(stateDir);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.key, rows[1]?.key);
    assert.equal(gog.writes().length, 1);
  });
});
