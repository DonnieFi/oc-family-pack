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
    ],
  );
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
    { date: "2026-10-01", isToday: false, eventIds: [] },
    { date: "2026-10-02", isToday: false, eventIds: ["c0/e3"] },
    { date: "2026-10-03", isToday: false, eventIds: ["c0/e2"] },
    { date: "2026-10-04", isToday: false, eventIds: ["c0/e2"] },
  ]);
  const utc = resolveWeek(undefined, now, "UTC");
  assert.deepEqual(groupByDay(utc.dates, utc.today, events, "UTC")[3], { date: "2026-10-01", isToday: false, eventIds: ["c0/e1"] });
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
  assert.deepEqual(ok.status === "ok" && [ok.data.length, ok.warnings], [5, []]);
  assert.deepEqual(unreadable, { status: "error", message: 'Could not read the "Kid" calendar: gog returned unreadable output' });
});

test("a gog run that outlives its timeout is reported as timed out", async () => {
  const slow = fakeGog("slow", "exec sleep 5");
  const state = await readGogCalendars(familyConfig(slow, [{ id: "cal-kid", label: "Kid" }]), week, execGog(100));
  assert.deepEqual(state, { status: "error", message: 'Could not read the "Kid" calendar: gog timed out' });
});

test("one failing calendar becomes a redacted warning while the others still show; all failing is an error", async () => {
  const gog = fakeGog(
    "one-busy",
    `case "$last" in *busy*) echo "Google API error (429 rateLimitExceeded): Rate Limit Exceeded for $last" >&2; exit 5;; esac\ncat '${fixturePath}'`,
  );
  const mixed = await readGogCalendars(
    familyConfig(gog, [
      { id: "busy-feed@group.calendar.google.com", label: "Busy" },
      { id: "cal-kid", label: "Kid" },
    ]),
    week,
  );
  assert.deepEqual(mixed.status === "ok" && [mixed.data.map((event) => event.id), mixed.warnings], [
    ["c1/e1", "c1/e2", "c1/e3", "c1/e5", "c1/e6"],
    ['Could not read the "Busy" calendar: Google API error (429 rateLimitExceeded): Rate Limit Exceeded for <id>'],
  ]);
  const allBusy = await readGogCalendars(
    familyConfig(gog, [
      { id: "busy-a@example.com", label: "A" },
      { id: "busy-b@example.com", label: "B" },
    ]),
    week,
  );
  assert.deepEqual(allBusy, {
    status: "error",
    message:
      'Could not read the "A" calendar: Google API error (429 rateLimitExceeded): Rate Limit Exceeded for <id> Could not read the "B" calendar: Google API error (429 rateLimitExceeded): Rate Limit Exceeded for <id>',
  });
});
