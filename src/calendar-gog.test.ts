import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execGog, parseGogEvents, readGogCalendars, type RunGog } from "./calendar-gog.ts";
import { parseConfig } from "./config.ts";
import { groupByDay, resolveWeek } from "./week.ts";

const fixturePath = new URL("./fixtures/gog-events.json", import.meta.url).pathname;
const gogOutput = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
const now = Date.parse("2026-09-30T16:00:00Z");
const week = resolveWeek(undefined, now, "America/Toronto");
const scripts = mkdtempSync(join(tmpdir(), "ocfp-gog-"));
after(() => rmSync(scripts, { recursive: true, force: true }));

function familyConfig(gogPath: string, calendars: { id: string; label: string }[]) {
  return parseConfig({
    timezone: "America/Toronto",
    gogPath,
    members: [{ profileId: "kid", displayName: "Kid", role: "kid" }],
    calendars: calendars.map((calendar) => ({ ...calendar, kind: "personal", owners: ["kid"] })),
  });
}

/** A stand-in gog: a real executable, so failures arrive in execFile's own shape. */
function fakeGog(name: string, body: string): string {
  const path = join(scripts, name);
  writeFileSync(path, `#!/bin/sh\nfor last; do :; done\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const kidCalendar = familyConfig("gog", [{ id: "cal-kid", label: "Kid" }]).calendars[0]!;

test("gog events become wire events keyed by calendar position, with Google write fields kept aside", () => {
  const events = parseGogEvents(gogOutput, kidCalendar) ?? [];
  assert.deepEqual(
    events.map((event) => [event.id, event.title, event.start, event.end, event.allDay]),
    [
      ["c0/e1", "Late swim", "2026-10-01T01:00:00.000Z", "2026-10-01T02:00:00.000Z", false],
      ["c0/e2", "Sleepover", "2026-10-03T23:00:00.000Z", "2026-10-04T14:00:00.000Z", false],
      ["c0/e3", "Pizza day", "2026-10-02", "2026-10-03", true],
      ["c0/e5", "School drop-off", "2026-09-28T12:15:00.000Z", "2026-09-28T12:45:00.000Z", false],
      ["c0/e6", "(No title)", "2026-09-29T16:00:00.000Z", "2026-09-29T16:30:00.000Z", false],
      ["c0/e7", "Art & music", "2026-10-01T19:00:00.000Z", "2026-10-01T20:00:00.000Z", false],
    ],
  );
  assert.equal(events.find((event) => event.id === "c0/e7")?.location, "Room 'A'");
  assert.equal(events.filter((event) => event.id === "c0/e1").length, 1);
  assert.equal(events.some((event) => event.title === "Impossible day"), false);
  assert.deepEqual(events[0], {
    id: "c0/e1",
    title: "Late swim",
    start: "2026-10-01T01:00:00.000Z",
    end: "2026-10-01T02:00:00.000Z",
    allDay: false,
    calendarKey: "c0",
    location: "Community Pool",
    htmlLink: "https://www.google.com/calendar/event?eid=ZXhhbXBsZS1lMQ",
    google: { eventId: "e1", updated: "2026-09-20T14:03:11.123Z", etag: '"3000000000000001"' },
  });
});

test("recurring instances keep their series id and original slot; unsafe links and junk revisions are dropped", () => {
  const events = parseGogEvents(gogOutput, kidCalendar) ?? [];
  const google = (id: string) => {
    const event = events.find((entry) => entry.id === id);
    return event && [event.htmlLink, event.google];
  };
  assert.deepEqual(google("c0/e3"), [undefined, { eventId: "e3", recurringEventId: "pizza-series", originalStart: "2026-10-02" }]);
  assert.deepEqual(google("c0/e5"), [
    undefined,
    { eventId: "e5", recurringEventId: "dropoff-series", originalStart: "2026-09-28T12:00:00.000Z" },
  ]);
  assert.deepEqual(google("c0/e6"), [undefined, { eventId: "e6" }]);
});

test("a Google link whose eid decodes to a calendar address is omitted", () => {
  const email = "parent@example.com";
  const eid = Buffer.from(`e9 ${email}`).toString("base64");
  const events =
    parseGogEvents(
      [
        {
          id: "e9",
          summary: "Practice",
          htmlLink: `https://calendar.google.com/calendar/event?eid=${eid}`,
          start: { dateTime: "2026-10-01T15:00:00Z" },
          end: { dateTime: "2026-10-01T16:00:00Z" },
        },
        {
          id: "e10",
          summary: "Homepage",
          htmlLink: "https://example.com/event",
          start: { date: "2026-10-01" },
        },
        {
          id: "e11",
          summary: "Address in the query",
          htmlLink: "https://www.google.com/calendar/event?eid=ZXhhbXBsZS1lMQ&src=parent@example.com",
          start: { date: "2026-10-01" },
        },
      ],
      kidCalendar,
    ) ?? [];
  const payload = JSON.stringify(events);
  assert.equal(payload.includes(email), false);
  assert.equal(payload.includes(eid), false);
  assert.equal(payload.includes("example.com"), false);
  assert.deepEqual(
    events.map((event) => event.htmlLink),
    [undefined, undefined, undefined],
  );
});

test("over-long Google strings are cut to their wire limits and an over-long link is dropped", () => {
  const [event] =
    parseGogEvents(
      [
        {
          id: "x".repeat(1100),
          summary: "T".repeat(600),
          location: "L".repeat(700),
          htmlLink: `https://calendar.google.com/${"a".repeat(2100)}`,
          start: { date: "2026-10-01" },
        },
      ],
      kidCalendar,
    ) ?? [];
  assert.deepEqual(
    event && [event.id.length, event.title.length, event.location?.length, event.htmlLink, event.google.eventId.length],
    [1040, 500, 500, undefined, 1100],
  );
});

test("events group onto local days in the configured timezone, not UTC days", () => {
  const events = parseGogEvents(gogOutput, kidCalendar) ?? [];
  assert.deepEqual(week.range, { start: "2026-09-28", end: "2026-10-04", timezone: "America/Toronto" });
  assert.deepEqual(groupByDay(week.dates, week.today, events, "America/Toronto"), [
    { date: "2026-09-28", isToday: false, eventIds: ["c0/e5"] },
    { date: "2026-09-29", isToday: false, eventIds: ["c0/e6"] },
    { date: "2026-09-30", isToday: true, eventIds: ["c0/e1"] },
    { date: "2026-10-01", isToday: false, eventIds: ["c0/e7"] },
    { date: "2026-10-02", isToday: false, eventIds: ["c0/e3"] },
    { date: "2026-10-03", isToday: false, eventIds: ["c0/e2"] },
    { date: "2026-10-04", isToday: false, eventIds: ["c0/e2"] },
  ]);
  const utc = resolveWeek(undefined, now, "UTC");
  assert.deepEqual(groupByDay(utc.dates, utc.today, events, "UTC")[3], {
    date: "2026-10-01",
    isToday: false,
    eventIds: ["c0/e1", "c0/e7"],
  });
});

test("gog gets the week window and the calendar id after --, so an id cannot pass as a flag", async () => {
  const calls: string[][] = [];
  const run: RunGog = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: "[]" };
  };
  const state = await readGogCalendars(familyConfig("/opt/gog", [{ id: "-kid@example.com", label: "Kid" }]), week, run);
  assert.deepEqual(state, { status: "ok", data: [], warnings: [] });
  assert.deepEqual(calls, [
    [
      "/opt/gog",
      "calendar",
      "events",
      "--from",
      "2026-09-28T04:00:00.000Z",
      "--to",
      "2026-10-05T04:00:00.000Z",
      "--all-pages",
      "--max",
      "250",
      "--json",
      "--no-input",
      "--",
      "-kid@example.com",
    ],
  ]);
});

test("a missing gog binary or an unauthorized gog reads as not set up", async () => {
  const missing = await readGogCalendars(familyConfig(join(scripts, "not-installed"), [{ id: "cal-kid", label: "Kid" }]), week);
  const signedOut = fakeGog(
    "signed-out",
    "echo 'missing --account (or set GOG_ACCOUNT, set default via `gog auth manage`, or store exactly one token)' >&2; exit 2",
  );
  const unauthorized = await readGogCalendars(familyConfig(signedOut, [{ id: "cal-kid", label: "Kid" }]), week);
  const hint =
    "Install gog, run `gog auth add you@example.com --services calendar`, then list calendar IDs with `gog calendar calendars`.";
  assert.deepEqual([missing, unauthorized], [
    { status: "unconfigured", hint },
    { status: "unconfigured", hint },
  ]);
});

test("stderr from a gog run that succeeded is not read as an auth failure; unreadable stdout is its own error", async () => {
  const noisy = fakeGog("noisy", `echo 'Note: Using direct access token (expires in ~1 hour)' >&2; cat '${fixturePath}'`);
  const garbled = fakeGog("garbled", "echo 'Note: token refreshed' >&2; echo 'not json'");
  const ok = await readGogCalendars(familyConfig(noisy, [{ id: "cal-kid", label: "Kid" }]), week);
  const unreadable = await readGogCalendars(familyConfig(garbled, [{ id: "cal-kid", label: "Kid" }]), week);
  assert.deepEqual(ok.status === "ok" && [ok.data.length, ok.warnings], [6, []]);
  assert.deepEqual(unreadable, { status: "error", message: 'Could not read the "Kid" calendar: unreadable output' });
});

test("a gog run that outlives its timeout is reported as timed out", async () => {
  const slow = fakeGog("slow", "exec sleep 5");
  const state = await readGogCalendars(familyConfig(slow, [{ id: "cal-kid", label: "Kid" }]), week, execGog(100));
  assert.deepEqual(state, { status: "error", message: 'Could not read the "Kid" calendar: timed out' });
});

test("one failing calendar becomes a fixed warning while the others still show; all failing is an error", async () => {
  const gog = fakeGog(
    "one-busy",
    `case "$last" in *busy*) echo "Google API error (429 rateLimitExceeded): Rate Limit Exceeded for teacher@example.com" >&2; exit 5;; esac\ncat '${fixturePath}'`,
  );
  const mixed = await readGogCalendars(
    familyConfig(gog, [
      { id: "busy-feed@group.calendar.google.com", label: "Busy" },
      { id: "cal-kid", label: "Kid" },
    ]),
    week,
  );
  assert.deepEqual(mixed.status === "ok" && [mixed.data.map((event) => event.id), mixed.warnings], [
    ["c1/e1", "c1/e2", "c1/e3", "c1/e5", "c1/e6", "c1/e7"],
    ['Could not read the "Busy" calendar: gog error code 5'],
  ]);
  assert.equal(JSON.stringify(mixed).includes("teacher@example.com"), false);
  assert.equal(JSON.stringify(mixed).includes("busy-feed@group.calendar.google.com"), false);
  const allBusy = await readGogCalendars(
    familyConfig(gog, [
      { id: "busy-a@example.com", label: "A" },
      { id: "busy-b@example.com", label: "B" },
    ]),
    week,
  );
  assert.deepEqual(allBusy, {
    status: "error",
    message: 'Could not read the "A" calendar: gog error code 5 Could not read the "B" calendar: gog error code 5',
  });
  assert.equal(JSON.stringify(allBusy).includes("teacher@example.com"), false);
});

test("one calendar's auth failure warns by name and the others still render; every auth failure is not set up", async () => {
  const gog = fakeGog(
    "mixed-auth",
    `case "$last" in *school*) echo 'invalid_grant for teacher@example.com' >&2; exit 1;; esac\ncat '${fixturePath}'`,
  );
  const mixed = await readGogCalendars(
    familyConfig(gog, [
      { id: "school@example.com", label: "School" },
      { id: "cal-kid", label: "Kid" },
    ]),
    week,
  );
  assert.deepEqual(mixed.status === "ok" && [mixed.data.map((event) => event.id), mixed.warnings], [
    ["c1/e1", "c1/e2", "c1/e3", "c1/e5", "c1/e6", "c1/e7"],
    ["Reconnect gog for School"],
  ]);
  assert.equal(JSON.stringify(mixed).includes("teacher@example.com"), false);
  assert.equal(JSON.stringify(mixed).includes("invalid_grant"), false);
  const hint =
    "Install gog, run `gog auth add you@example.com --services calendar`, then list calendar IDs with `gog calendar calendars`.";
  const signedOut = fakeGog("all-auth", "echo 'invalid_grant for teacher@example.com' >&2; exit 1");
  const allAuth = await readGogCalendars(
    familyConfig(signedOut, [
      { id: "school@example.com", label: "School" },
      { id: "kid@example.com", label: "Kid" },
    ]),
    week,
  );
  assert.deepEqual(allAuth, { status: "unconfigured", hint });
  assert.equal(JSON.stringify(allAuth).includes("teacher@example.com"), false);
});

test("an all-day date that does not exist is dropped and the week read still succeeds", async () => {
  const run: RunGog = async () => ({
    stdout: JSON.stringify({
      events: [
        { id: "bad", summary: "Impossible day", start: { date: "2026-13-45" }, end: { date: "2026-13-46" } },
        { id: "ok", summary: "Pizza day", start: { date: "2026-10-02" }, end: { date: "2026-10-03" } },
      ],
    }),
  });
  const state = await readGogCalendars(familyConfig("gog", [{ id: "cal-kid", label: "Kid" }]), week, run);
  assert.deepEqual(state, {
    status: "ok",
    data: [{ id: "c0/ok", title: "Pizza day", start: "2026-10-02", end: "2026-10-03", allDay: true, calendarKey: "c0" }],
    warnings: [],
  });
});

test("a calendar that still has another page warns without copying the page token", async () => {
  const run: RunGog = async () => ({
    stdout: JSON.stringify({
      events: [{ id: "e9", summary: "Assembly", start: { date: "2026-10-02" }, end: { date: "2026-10-03" } }],
      nextPageToken: "page-token-secret",
    }),
  });
  const state = await readGogCalendars(familyConfig("gog", [{ id: "school@example.com", label: "School" }]), week, run);
  assert.deepEqual(state, {
    status: "ok",
    data: [{ id: "c0/e9", title: "Assembly", start: "2026-10-02", end: "2026-10-03", allDay: true, calendarKey: "c0" }],
    warnings: ['The "School" calendar hit gog\'s page cap, so some events are missing.'],
  });
  assert.equal(JSON.stringify(state).includes("page-token-secret"), false);
});

test("gog's page-cap failure is a fixed warning and does not copy stderr", async () => {
  const gog = fakeGog(
    "page-cap",
    `case "$last" in *school*) echo 'pagination exceeded max pages after teacher@example.com' >&2; exit 1;; esac\ncat '${fixturePath}'`,
  );
  const state = await readGogCalendars(
    familyConfig(gog, [
      { id: "school@example.com", label: "School" },
      { id: "cal-kid", label: "Kid" },
    ]),
    week,
  );
  assert.equal(state.status, "ok");
  assert.deepEqual(state.status === "ok" && state.warnings, ['The "School" calendar hit gog\'s page cap, so some events are missing.']);
  assert.equal(JSON.stringify(state).includes("teacher@example.com"), false);
  assert.equal(JSON.stringify(state).includes("pagination exceeded"), false);
  assert.equal(state.status === "ok" && state.data.some((event) => event.id === "c1/e7"), true);
});
