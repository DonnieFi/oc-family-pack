import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Value } from "typebox/value";
import { GarbageOutputSchema } from "./contract.ts";
import { createGarbageFeed, garbageSchedule, GARBAGE_BODY_MAX, GARBAGE_DOWN, GARBAGE_NONE, GARBAGE_UNSET, isLocalHost, parseIcs, type GarbageFetch } from "./garbage.ts";

const ICS = readFileSync(new URL("./fixtures/garbage-recollect.ics", import.meta.url), "utf8");
/** What Bernie's own garbage_service.py returned for this fixture (~/ocfp-share/runs/s5k.21-bernie-golden.py). */
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/garbage-golden.json", import.meta.url), "utf8")) as {
  timezone: string;
  parsed: { date: string; summary: string }[];
  cases: { now: string; next14: Collection[]; toolText: string; tomorrow: Collection | null; briefLine: string | null }[];
};
type Collection = { date: string; summary: string; icon: string };
const TZ = GOLDEN.timezone;
const URL_ = "https://recollect.example/api/places/PLACE-1234/services/waste/events.en.ics?client_id=secret-77";
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

type Answer = string | number | Error | ((init: { signal: AbortSignal }) => Response | Promise<Response>);

/** A stand-in feed: answers from a queue (the last answer repeats), recording each call. */
function stub(...answers: Answer[]) {
  const calls: { url: string; signal: AbortSignal; redirect: string }[] = [];
  const fetcher: GarbageFetch = async (url, init) => {
    calls.push({ url, signal: init.signal, redirect: init.redirect });
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(init);
    return typeof answer === "number" ? new Response("nope", { status: answer }) : new Response(answer, { status: 200 });
  };
  return { fetcher, calls };
}

const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
/** A fetch that never answers until its signal fires, as a hung server does. */
const hang = (init: { signal: AbortSignal }) =>
  new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));

/**
 * A body the reader has to pull, chunk by chunk, counting what was pulled and whether it was
 * cancelled. `bytes` past the cap, with whatever Content-Length the server claimed (or none).
 */
function pulledBody(bytes: number, headers: Record<string, string> = {}, head = "BEGIN:VCALENDAR\r\n") {
  const CHUNK = 65_536;
  const seen = { pulled: 0, cancelled: false };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= bytes) return controller.close();
        const size = Math.min(CHUNK, bytes - seen.pulled);
        const chunk = new Uint8Array(size).fill(0x58);
        if (seen.pulled === 0) chunk.set(encoder.encode(head));
        seen.pulled += size;
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, CHUNK, answer: () => new Response(body, { status: 200, headers }) };
}

/** Runs a check that must settle well inside the test timeout (a hung read would otherwise stall the suite). */
async function within<T>(ms: number, run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)));
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the parser reads the fixture exactly as Bernie's _parse_ics does: folded lines, escaped commas, sorted by date, malformed and timed events dropped", () => {
  assert.deepEqual(parseIcs(ICS), GOLDEN.parsed);
});

test("for every day in the golden, the next 14 days and tomorrow match Bernie's get_next_collections and get_tomorrow_collection", async () => {
  const feed = createGarbageFeed(stub(ICS).fetcher);
  for (const golden of GOLDEN.cases) {
    assert.deepEqual(await feed.next(URL_, TZ, at(golden.now), 14), golden.next14, golden.now);
    assert.deepEqual(await feed.tomorrow(URL_, TZ, at(golden.now)), golden.tomorrow ?? undefined, golden.now);
  }
});

test("the garbage_schedule tool gives the same dates and words as Bernie's get_garbage_schedule tool", async () => {
  const feed = createGarbageFeed(stub(ICS).fetcher);
  for (const golden of GOLDEN.cases) {
    const output = await garbageSchedule(feed, { timezone: TZ, garbageIcsUrl: URL_ }, at(golden.now));
    assert.ok(Value.Check(GarbageOutputSchema, output), JSON.stringify(output));
    const text = "collections" in output ? ["Upcoming collections:", ...output.collections.map((c) => `- ${c.date}: ${c.what}`)].join("\n") : "note" in output ? output.note : output.error;
    assert.equal(text, golden.toolText, golden.now);
  }
});

test("one fetch serves seven days; on day eight the feed is read again", async () => {
  const { fetcher, calls } = stub(ICS);
  const feed = createGarbageFeed(fetcher);
  const start = at("2026-10-04T12:00:00-03:00");
  await feed.tomorrow(URL_, TZ, start);
  await feed.next(URL_, TZ, start + 7 * DAY - 1, 14);
  assert.equal(calls.length, 1);
  await feed.next(URL_, TZ, start + 7 * DAY, 14);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, URL_);
  assert.ok(calls[0]!.signal instanceof AbortSignal);
});

test("when the feed fails after a good read, the last copy is served, however old, until the process restarts", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  // 203 carries a real (empty) calendar: only the status check refuses it, as Bernie's == 200 did.
  const emptyCalendar203 = () => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { status: 203 });
  for (const failure of [500, 404, emptyCalendar203, new Error("fetch failed")]) {
    const { fetcher, calls } = stub(ICS, failure);
    const feed = createGarbageFeed(fetcher);
    assert.equal((await feed.tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling");
    const later = start + 7 * DAY;
    assert.deepEqual(await feed.next(URL_, TZ, later, 14), GOLDEN.cases.find((c) => c.now === "2026-10-11T12:00:00-03:00")!.next14, String(failure));
    assert.equal((await feed.tomorrow(URL_, TZ, later))?.summary, "Garbage, Green Bin, and Recycling");
    assert.equal(calls.length, 3, String(failure));
  }
});

test("after a restart with the feed down there is nothing: no tomorrow for the brief, no list, and the tool says it could not read the feed", async () => {
  const now = at("2026-10-04T12:00:00-03:00");
  const { fetcher } = stub(ICS);
  await createGarbageFeed(fetcher).next(URL_, TZ, now, 14);
  for (const failure of [503, new Error("getaddrinfo ENOTFOUND")]) {
    const restarted = createGarbageFeed(stub(failure).fetcher);
    assert.equal(await restarted.tomorrow(URL_, TZ, now), undefined);
    assert.equal(await restarted.next(URL_, TZ, now, 14), undefined);
    assert.deepEqual(await garbageSchedule(restarted, { timezone: TZ, garbageIcsUrl: URL_ }, now), { error: GARBAGE_DOWN });
  }
});

test("callers asking at once share one fetch", async () => {
  let release: (() => void) | undefined;
  let count = 0;
  const feed = createGarbageFeed(async () => {
    count += 1;
    await new Promise<void>((resolve) => (release = resolve));
    return new Response(ICS, { status: 200 });
  });
  const now = at("2026-10-04T12:00:00-03:00");
  const both = Promise.all([feed.tomorrow(URL_, TZ, now), feed.next(URL_, TZ, now, 14)]);
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  const [tomorrow, next] = await both;
  assert.equal(count, 1);
  assert.equal(tomorrow?.summary, "Green Bin and Recycling");
  assert.equal(next?.length, 3);
});

test("without a feed URL the tool says so and fetches nothing; with an empty window it says there is nothing", async () => {
  const { fetcher, calls } = stub(ICS);
  const feed = createGarbageFeed(fetcher);
  const unset = await garbageSchedule(feed, { timezone: TZ }, at("2026-10-04T12:00:00-03:00"));
  assert.deepEqual(unset, { error: "Garbage day isn't set up yet. Ask the person who set this up to add the city's collection calendar." });
  assert.equal(GARBAGE_UNSET, "Garbage day isn't set up yet. Ask the person who set this up to add the city's collection calendar.");
  // A household member reads this reply: no config key, path or plugin name in it.
  assert.doesNotMatch(JSON.stringify(unset), /garbageIcsUrl|garbage_?ics|config|plugin|oc-family-pack|Family plugin|\.json|\//i);
  assert.equal(calls.length, 0);
  assert.deepEqual(await garbageSchedule(feed, { timezone: TZ, garbageIcsUrl: URL_ }, at("2026-11-20T12:00:00-04:00")), { note: GARBAGE_NONE });
});

test("tool replies carry no ids: not the feed URL or its place id, and nothing the city put in a summary beyond the four words", async () => {
  const noisy = ICS.replace("SUMMARY:Recycling and Green Cart", "SUMMARY:Recycling for account 123456789012345678 <@100000000000000001> https://x.example/u/42");
  const now = at("2026-10-04T12:00:00-03:00");
  const answers = [
    await garbageSchedule(createGarbageFeed(stub(noisy).fetcher), { timezone: TZ, garbageIcsUrl: URL_ }, now),
    await garbageSchedule(createGarbageFeed(stub(500).fetcher), { timezone: TZ, garbageIcsUrl: URL_ }, now),
    await garbageSchedule(createGarbageFeed(stub(noisy).fetcher), { timezone: TZ }, now),
  ];
  assert.deepEqual(answers[0], { collections: [{ date: "Monday, Oct 05", what: "Recycling" }, { date: "Monday, Oct 05", what: "Collection" }, { date: "Monday, Oct 12", what: "Garbage, Green Bin, and Recycling" }] });
  for (const answer of answers) {
    const json = JSON.stringify(answer);
    assert.doesNotMatch(json, /\d{5,}|PLACE|recollect|secret|https?:|<@/, json);
  }
});

test("tomorrow and the next days come from the household's zone, not UTC: Sunday 8 PM in Halifax is already Monday in UTC", async () => {
  const feed = createGarbageFeed(stub(ICS).fetcher);
  // After DST ends (AST, UTC-4): 8 PM Sunday Nov 8 is 00:00 Monday Nov 9 UTC. Tomorrow is Monday's Garbage, not Tuesday's Recycling.
  assert.deepEqual(await feed.tomorrow(URL_, TZ, at("2026-11-08T20:00:00-04:00")), { date: "2026-11-09", summary: "Garbage", icon: "🗑️" });
  // The changeover night (02:00 ADT -> 01:00 AST on Sunday Nov 1) and 8 PM that Sunday all say Monday Nov 2.
  for (const now of ["2026-11-01T00:30:00-03:00", "2026-11-01T01:30:00-03:00", "2026-11-01T01:30:00-04:00", "2026-11-01T20:00:00-04:00", "2026-11-01T23:30:00-04:00"]) {
    assert.equal((await feed.tomorrow(URL_, TZ, at(now)))?.date, "2026-11-02", now);
  }
  assert.equal(await feed.tomorrow(URL_, TZ, at("2026-10-31T23:30:00-03:00")), undefined);
  // The golden holds these instants too, as Bernie's own code answered them.
  const nows = new Set(GOLDEN.cases.map((c) => c.now));
  for (const now of ["2026-11-01T20:00:00-04:00", "2026-11-08T20:00:00-04:00", "2026-10-31T23:30:00-03:00", "2026-11-01T00:30:00-03:00", "2026-11-01T01:30:00-03:00", "2026-11-01T23:30:00-04:00"]) {
    assert.ok(nows.has(now), now);
  }
});

test("an all-day DATE is a plain date in any household zone: Monday's pickup is Monday at both ends of the clock", async () => {
  const feed = createGarbageFeed(stub(ICS).fetcher);
  for (const [zone, sundayNoon] of [["Pacific/Kiritimati", "2026-11-08T12:00:00+14:00"], ["Pacific/Pago_Pago", "2026-11-08T12:00:00-11:00"], ["UTC", "2026-11-08T12:00:00Z"]] as const) {
    assert.deepEqual(await feed.tomorrow(URL_, zone, at(sundayNoon)), { date: "2026-11-09", summary: "Garbage", icon: "🗑️" }, zone);
    assert.deepEqual((await feed.next(URL_, zone, at(sundayNoon), 2))?.map((c) => c.date), ["2026-11-09", "2026-11-10"], zone);
  }
});

test("a read that hangs past the timeout, before or during the body, serves the last copy; with none there is nothing", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const stalledBody = () =>
    new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR\r\n")), pull: () => new Promise(() => {}) }), { status: 200 });
  for (const [name, stall] of [["no answer", hang], ["body stalls", stalledBody]] as const) {
    const lines: string[] = [];
    const { fetcher } = stub(ICS, stall);
    const feed = createGarbageFeed(fetcher, { timeoutMs: 50, log: (line) => lines.push(line) });
    await feed.next(URL_, TZ, start, 14);
    assert.equal((await within(2_000, feed.tomorrow(URL_, TZ, start + 7 * DAY)))?.summary, "Garbage, Green Bin, and Recycling", name);
    const fresh = createGarbageFeed(stub(stall).fetcher, { timeoutMs: 50, log: (line) => lines.push(line) });
    assert.deepEqual(await within(2_000, garbageSchedule(fresh, { timezone: TZ, garbageIcsUrl: URL_ }, start)), { error: GARBAGE_DOWN }, name);
    assert.deepEqual(lines, ["oc-family-pack: the garbage calendar timed out; using the last copy", "oc-family-pack: the garbage calendar timed out; no garbage line until it answers"], name);
  }
});

test("redirects are followed by hand to http(s) links only, at most three; anywhere else is a failed read", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const followed = stub(redirect("https://cdn.example/feed.ics", 301), redirect("/again.ics", 307), redirect("https://plain.example/x.ics", 308), ICS);
  assert.equal((await createGarbageFeed(followed.fetcher).tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling");
  assert.deepEqual(followed.calls.map((c) => c.url), [URL_, "https://cdn.example/feed.ics", "https://cdn.example/again.ics", "https://plain.example/x.ics"]);
  assert.ok(followed.calls.every((c) => c.redirect === "manual"));

  const refused: [string, Answer[]][] = [
    ["https to file:", [redirect("file:///etc/passwd")]],
    ["https to ftp:", [redirect("ftp://recollect.example/feed.ics")]],
    ["https to data:", [redirect("data:text/calendar,BEGIN:VCALENDAR")]],
    ["no Location", [() => new Response(null, { status: 302 })]],
    ["four redirects", [redirect("https://a.example/1"), redirect("https://a.example/2"), redirect("https://a.example/3"), redirect("https://a.example/4"), ICS]],
  ];
  for (const [name, answers] of refused) {
    const lines: string[] = [];
    const { fetcher, calls } = stub(...answers);
    const fresh = createGarbageFeed(fetcher, { log: (line) => lines.push(line) });
    assert.equal(await fresh.tomorrow(URL_, TZ, start), undefined, name);
    assert.ok(calls.every((c) => /^https?:/.test(c.url)), name);
    assert.equal(calls.length, name === "four redirects" ? 4 : 1, name);
    assert.match(lines[0]!, name === "four redirects" ? /redirected more than three times/ : /redirected somewhere other than an http\(s\) link/, name);
    const cached = createGarbageFeed(stub(ICS, ...answers).fetcher);
    await cached.next(URL_, TZ, start, 14);
    assert.equal((await cached.tomorrow(URL_, TZ, start + 7 * DAY))?.summary, "Garbage, Green Bin, and Recycling", name);
  }
});

test("a body past 1 MiB is cut off at 1 MiB whatever Content-Length says, and counts as a failed read", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  // A calendar with a pickup in it, so a reader that kept the first MiB would answer something else.
  const head = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261012\r\nSUMMARY:Bulky items\r\nEND:VEVENT\r\nX-PAD:";
  for (const [name, headers] of [["chunked, no Content-Length", {}], ["Content-Length: 100", { "content-length": "100" }]] as const) {
    const fresh = pulledBody(2 * GARBAGE_BODY_MAX, headers, head);
    const lines: string[] = [];
    assert.deepEqual(await garbageSchedule(createGarbageFeed(stub(fresh.answer).fetcher, { log: (line) => lines.push(line) }), { timezone: TZ, garbageIcsUrl: URL_ }, start), { error: GARBAGE_DOWN }, name);
    assert.ok(fresh.seen.pulled <= GARBAGE_BODY_MAX + fresh.CHUNK, `${name}: pulled ${fresh.seen.pulled}`);
    assert.equal(fresh.seen.cancelled, true, name);
    assert.deepEqual(lines, ["oc-family-pack: the garbage calendar sent more than 1 MiB; no garbage line until it answers"], name);

    const later = pulledBody(2 * GARBAGE_BODY_MAX, headers, head);
    const cached = createGarbageFeed(stub(ICS, later.answer).fetcher);
    await cached.next(URL_, TZ, start, 14);
    assert.deepEqual(await cached.next(URL_, TZ, start + 7 * DAY, 14), GOLDEN.cases.find((c) => c.now === "2026-10-11T12:00:00-03:00")!.next14, name);
    assert.ok(later.seen.pulled <= GARBAGE_BODY_MAX + later.CHUNK && later.seen.cancelled, name);
  }
  // Exactly 1 MiB is still a calendar.
  const padding = GARBAGE_BODY_MAX - new TextEncoder().encode(ICS).byteLength - "X-PAD:\r\n".length;
  const full = ICS.replace("END:VCALENDAR", `X-PAD:${"x".repeat(padding)}\r\nEND:VCALENDAR`);
  assert.equal(new TextEncoder().encode(full).byteLength, GARBAGE_BODY_MAX);
  assert.equal((await createGarbageFeed(stub(full).fetcher).tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling");
});

test("over real HTTP: a chunked 2 MiB body is cut off, a redirect to file: is refused, the configured loopback feed is read and so is its redirect to another path on itself, but not to another port", async () => {
  let written = 0;
  const { server, base } = await listen((req, res) => {
    if (req.url === "/big.ics") {
      res.writeHead(200, { "content-type": "text/calendar" });
      const chunk = Buffer.alloc(65_536, 0x58);
      chunk.write("BEGIN:VCALENDAR\r\n");
      const pump = () => {
        while (written < 2 * GARBAGE_BODY_MAX) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => res.destroy());
      pump();
    } else if (req.url === "/to-file.ics") {
      res.writeHead(302, { location: "file:///etc/passwd" }).end();
    } else if (req.url === "/moved.ics") {
      res.writeHead(301, { location: "/feed.ics" }).end();
    } else if (req.url === "/other-port.ics") {
      const port = Number(new URL(`http://${req.headers.host}`).port);
      res.writeHead(302, { location: `http://127.0.0.1:${port === 65_535 ? 1_024 : port + 1}/feed.ics` }).end();
    } else {
      res.writeHead(200, { "content-type": "text/calendar" }).end(ICS);
    }
  });
  try {
    const now = at("2026-10-04T12:00:00-03:00");
    const lines: string[] = [];
    const feed = createGarbageFeed(fetch, { log: (line) => lines.push(line), timeoutMs: 5_000 });
    assert.equal(await feed.tomorrow(`${base}/big.ics`, TZ, now), undefined);
    assert.equal(await feed.tomorrow(`${base}/to-file.ics`, TZ, now), undefined);
    assert.equal((await feed.tomorrow(`${base}/feed.ics`, TZ, now))?.summary, "Green Bin and Recycling");
    assert.equal((await feed.tomorrow(`${base}/moved.ics`, TZ, now))?.summary, "Green Bin and Recycling");
    assert.equal(await feed.tomorrow(`${base}/other-port.ics`, TZ, now), undefined);
    assert.deepEqual(lines, [
      "oc-family-pack: the garbage calendar sent more than 1 MiB; no garbage line until it answers",
      "oc-family-pack: the garbage calendar redirected somewhere other than an http(s) link; no garbage line until it answers",
      "oc-family-pack: the garbage calendar redirected to a local address; no garbage line until it answers",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a body that is not a UTF-8 calendar is a failed read, never cached (Bernie cached whatever came back)", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const notCalendars: [string, Answer][] = [
    ["not UTF-8", () => new Response(new Uint8Array([0x42, 0x45, 0x47, 0x49, 0x4e, 0xff, 0xfe]), { status: 200 })],
    ["an HTML sign-in page", "<!doctype html><title>Sign in</title>"],
    ["empty", ""],
  ];
  for (const [name, answer] of notCalendars) {
    const lines: string[] = [];
    const { fetcher, calls } = stub(answer, ICS);
    const feed = createGarbageFeed(fetcher, { log: (line) => lines.push(line) });
    assert.equal(await feed.tomorrow(URL_, TZ, start), undefined, name);
    assert.match(lines[0]!, name === "not UTF-8" ? /did not send UTF-8 text; no garbage line/ : /did not send a calendar; no garbage line/, name);
    assert.equal((await feed.tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling", name);
    assert.equal(calls.length, 2, name);
    const cached = createGarbageFeed(stub(ICS, answer).fetcher);
    await cached.next(URL_, TZ, start, 14);
    assert.equal((await cached.tomorrow(URL_, TZ, start + 7 * DAY))?.summary, "Garbage, Green Bin, and Recycling", name);
  }
});

test("no failure puts any part of the feed URL in the tool reply or the log", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const failures: [string, Answer][] = [
    ["timeout", hang],
    ["non-2xx", () => new Response(`no such place ${URL_}`, { status: 404 })],
    ["other 2xx", 204],
    ["redirect to file:", redirect(`file:///${URL_}`)],
    ["too many redirects", redirect(URL_)],
    ["oversize", pulledBody(2 * GARBAGE_BODY_MAX, { "content-length": "100" }, `BEGIN:VCALENDAR\r\nX-URL:${URL_}\r\n`).answer],
    ["parse error", `<html>${URL_}</html>`],
    ["thrown with the URL in it", new TypeError(`fetch failed: getaddrinfo ENOTFOUND recollect.example (${URL_})`)],
  ];
  const parts = ["recollect.example", "PLACE-1234", "events.en.ics", "secret-77", "/api/places", "client_id"];
  for (const [name, answer] of failures) {
    for (const cachedFirst of [false, true]) {
      const lines: string[] = [];
      const { fetcher } = stub(...(cachedFirst ? [ICS, answer] : [answer]));
      const feed = createGarbageFeed(fetcher, { timeoutMs: 50, log: (line) => lines.push(line) });
      const config = { timezone: TZ, garbageIcsUrl: URL_ };
      if (cachedFirst) await garbageSchedule(feed, config, start);
      const reply = JSON.stringify(await within(2_000, garbageSchedule(feed, config, start + 7 * DAY)));
      const tomorrow = JSON.stringify(await feed.tomorrow(URL_, TZ, start + 14 * DAY) ?? null);
      assert.equal(lines.length, 2, `${name}: ${lines.join(" | ")}`);
      if (!cachedFirst) assert.deepEqual(JSON.parse(reply), { error: GARBAGE_DOWN }, name);
      for (const text of [reply, tomorrow, ...lines]) {
        for (const part of parts) assert.ok(!text.includes(part), `${name}: "${part}" in ${text}`);
      }
    }
  }
});

test("a redirect hop to a local address is refused, however the address is written; the URL parser reads it first", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const refused = [
    "https://127.0.0.1/feed.ics", "https://127.255.255.254/feed.ics", "https://10.0.0.5/feed.ics", "https://172.16.0.1/feed.ics", "https://172.31.255.255/feed.ics",
    "https://192.168.1.10/feed.ics", "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/feed.ics", "https://100.127.255.255/feed.ics", "https://0.0.0.0/feed.ics",
    "https://[::1]/feed.ics", "https://[fc00::1]/feed.ics", "https://[fd12:3456::1]/feed.ics", "https://[fe80::1]/feed.ics", "https://[febf::1]/feed.ics",
    "https://[::ffff:127.0.0.1]/feed.ics", "https://[::ffff:7f00:1]/feed.ics", "https://[::ffff:192.168.0.1]/feed.ics",
    // Written other ways; WHATWG parsing turns each into 127.0.0.1.
    "https://2130706433/feed.ics", "https://0x7f.1/feed.ics", "https://0177.0.0.1/feed.ics", "https://127.1/feed.ics",
    "https://localhost/feed.ics", "https://localhost./feed.ics", "https://LOCALHOST/feed.ics", "https://LocalHost:8443/feed.ics",
    "https://cal.localhost/feed.ics", "https://cal.localhost./feed.ics", "https://CAL.LOCALHOST/feed.ics",
    "//localhost/feed.ics",
  ];
  for (const location of refused) {
    const lines: string[] = [];
    const { fetcher, calls } = stub(redirect(location), ICS);
    assert.equal(await createGarbageFeed(fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, start), undefined, location);
    assert.equal(calls.length, 1, `${location} was followed`);
    assert.deepEqual(lines, ["oc-family-pack: the garbage calendar redirected to a local address; no garbage line until it answers"], location);
    const cached = createGarbageFeed(stub(ICS, redirect(location)).fetcher);
    await cached.next(URL_, TZ, start, 14);
    assert.equal((await cached.tomorrow(URL_, TZ, start + 7 * DAY))?.summary, "Garbage, Green Bin, and Recycling", location);
  }
});

test("an IPv6 zone id is never followed: the URL parser refuses it, and the host check strips one anyway", async () => {
  const lines: string[] = [];
  const { fetcher, calls } = stub(redirect("https://[fe80::1%25eth0]/feed.ics"), ICS);
  assert.equal(await createGarbageFeed(fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, at("2026-10-04T12:00:00-03:00")), undefined);
  assert.equal(calls.length, 1);
  assert.match(lines[0]!, /redirected somewhere other than an http\(s\) link/);
  assert.equal(isLocalHost("[fe80::1%eth0]"), true);
  assert.equal(isLocalHost("[fe80::1%25eth0]"), true);
  // The zone is stripped before the address is read: a public address with a zone is still a public address.
  assert.equal(isLocalHost("[2001:db8::1%eth0]"), false);
  // Anything else the check can't read as an address is treated as local and not followed.
  assert.equal(isLocalHost("[2001:db8::zz]"), true);
});

test("every hop is checked: a public first hop that redirects to loopback is refused; relative Locations resolve against the hop that sent them", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const lines: string[] = [];
  const twoHops = stub(redirect("https://cdn.example/feed.ics"), redirect("https://127.0.0.1/feed.ics"), ICS);
  assert.equal(await createGarbageFeed(twoHops.fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, start), undefined);
  assert.deepEqual(twoHops.calls.map((c) => c.url), [URL_, "https://cdn.example/feed.ics"]);
  const thirdHop = stub(redirect("https://cdn.example/a.ics"), redirect("https://cdn.example/b.ics"), redirect("https://[::1]/c.ics"), ICS);
  assert.equal(await createGarbageFeed(thirdHop.fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, start), undefined);
  assert.equal(thirdHop.calls.length, 3);

  // Relative: "../b.ics" sent by cdn.example/a/feed.ics is cdn.example/b.ics, followed.
  const relative = stub(redirect("https://cdn.example/a/feed.ics"), redirect("../b.ics"), ICS);
  assert.equal((await createGarbageFeed(relative.fetcher).tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling");
  assert.deepEqual(relative.calls.map((c) => c.url), [URL_, "https://cdn.example/a/feed.ics", "https://cdn.example/b.ics"]);
  // Scheme-relative "//192.168.0.9/x.ics" sent by the public hop resolves to https://192.168.0.9, and is refused.
  const lanRelative = stub(redirect("https://cdn.example/feed.ics"), redirect("//192.168.0.9/x.ics"), ICS);
  assert.equal(await createGarbageFeed(lanRelative.fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, start), undefined);
  assert.equal(lanRelative.calls.length, 2);
  assert.deepEqual(new Set(lines), new Set(["oc-family-pack: the garbage calendar redirected to a local address; no garbage line until it answers"]));
});

test("https never redirects down to http; http to http is followed", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const lines: string[] = [];
  for (const answers of [[redirect("http://cdn.example/feed.ics")], [redirect("https://cdn.example/feed.ics"), redirect("http://cdn.example/feed.ics")]]) {
    const { fetcher, calls } = stub(...answers, ICS);
    assert.equal(await createGarbageFeed(fetcher, { log: (line) => lines.push(line) }).tomorrow(URL_, TZ, start), undefined);
    assert.ok(calls.every((c) => c.url.startsWith("https:")));
    const cached = createGarbageFeed(stub(ICS, ...answers).fetcher);
    await cached.next(URL_, TZ, start, 14);
    assert.equal((await cached.tomorrow(URL_, TZ, start + 7 * DAY))?.summary, "Garbage, Green Bin, and Recycling");
  }
  assert.deepEqual(lines, Array(2).fill("oc-family-pack: the garbage calendar redirected from https to http; no garbage line until it answers"));
  const plain = stub(redirect("http://mirror.example/feed.ics"), ICS);
  assert.equal((await createGarbageFeed(plain.fetcher).tomorrow("http://city.example/feed.ics", TZ, start))?.summary, "Green Bin and Recycling");
  assert.deepEqual(plain.calls.map((c) => c.url), ["http://city.example/feed.ics", "http://mirror.example/feed.ics"]);
});

test("a hop with the configured link's own origin is followed even on the LAN; any other local hop is not", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  const LOCAL = "oc-family-pack: the garbage calendar redirected to a local address; no garbage line until it answers";
  const DOWN = "oc-family-pack: the garbage calendar redirected from https to http; no garbage line until it answers";
  // Same scheme, host and port, compared as URL origins, so a written default port is the same port.
  for (const [configured, location, landed] of [
    ["http://192.168.1.50/feed.ics", "/calendar/feed.ics", "http://192.168.1.50/calendar/feed.ics"],
    ["http://192.168.1.50/feed.ics", "http://192.168.1.50:80/v2.ics", "http://192.168.1.50/v2.ics"],
    ["https://192.168.1.50/feed.ics", "https://192.168.1.50:443/v2.ics", "https://192.168.1.50/v2.ics"],
    ["https://192.168.1.50:443/feed.ics", "https://192.168.1.50/v2.ics", "https://192.168.1.50/v2.ics"],
    ["http://NAS.localhost:8080/feed.ics", "http://nas.localhost:8080/v2.ics", "http://nas.localhost:8080/v2.ics"],
    ["http://[fd00::5]/feed.ics", "http://[fd00:0::5]/v2.ics", "http://[fd00::5]/v2.ics"],
  ]) {
    const { fetcher, calls } = stub(redirect(location!), ICS);
    assert.equal((await createGarbageFeed(fetcher).tomorrow(configured!, TZ, start))?.summary, "Green Bin and Recycling", location);
    assert.deepEqual(calls.map((c) => c.url), [configured, landed], location);
  }
  // The same host on another port or scheme, and LAN-A to LAN-B, are other origins.
  for (const [configured, location, line] of [
    ["http://192.168.1.50/feed.ics", "http://192.168.1.50:8080/feed.ics", LOCAL],
    ["https://192.168.1.50/feed.ics", "https://192.168.1.50:8443/feed.ics", LOCAL],
    ["https://192.168.1.50:443/feed.ics", "https://192.168.1.50:8443/feed.ics", LOCAL],
    // Userinfo is not the host: the origin of https://192.168.1.50@192.168.1.51/ is https://192.168.1.51.
    ["https://192.168.1.50/feed.ics", "https://192.168.1.50@192.168.1.51/feed.ics", LOCAL],
    ["https://cfg.localhost/feed.ics", "https://cfg.localhost@127.0.0.1/feed.ics", LOCAL],
    ["https://cfg.localhost/feed.ics", "https://cfg.localhost:x@localhost/feed.ics", LOCAL],
    ["http://192.168.1.50:8080/feed.ics", "http://192.168.1.50/feed.ics", LOCAL],
    ["http://192.168.1.50/feed.ics", "https://192.168.1.50/feed.ics", LOCAL],
    ["http://192.168.1.50/feed.ics", "http://192.168.1.51/feed.ics", LOCAL],
    ["http://localhost:8080/feed.ics", "http://127.0.0.1:8080/feed.ics", LOCAL],
    // https to http stays refused even on the configured host.
    ["https://192.168.1.50/feed.ics", "http://192.168.1.50/feed.ics", DOWN],
  ]) {
    const lines: string[] = [];
    const { fetcher, calls } = stub(redirect(location!), ICS);
    assert.equal(await createGarbageFeed(fetcher, { log: (l) => lines.push(l) }).tomorrow(configured!, TZ, start), undefined, location);
    assert.equal(calls.length, 1, `${location} was followed`);
    assert.deepEqual(lines, [line], location);
  }
  // The origin is the configured link's, not the previous hop's: a public feed that sends hop 1 to the LAN
  // is refused there, so hop 2 back to the public host is never asked for.
  const lines: string[] = [];
  const outAndBack = stub(redirect("https://192.168.1.50/feed.ics"), redirect(URL_), ICS);
  assert.equal(await createGarbageFeed(outAndBack.fetcher, { log: (l) => lines.push(l) }).tomorrow(URL_, TZ, start), undefined);
  assert.deepEqual(outAndBack.calls.map((c) => c.url), [URL_]);
  // A LAN feed that sends hop 1 to its own origin may not then reach another LAN host on hop 2.
  const lanHop2 = stub(redirect("/v2.ics"), redirect("http://192.168.1.51/feed.ics"), ICS);
  assert.equal(await createGarbageFeed(lanHop2.fetcher, { log: (l) => lines.push(l) }).tomorrow("http://192.168.1.50/feed.ics", TZ, start), undefined);
  assert.deepEqual(lanHop2.calls.map((c) => c.url), ["http://192.168.1.50/feed.ics", "http://192.168.1.50/v2.ics"]);
  // Leaving to a public host and coming back to the configured LAN origin is followed: it is the configured origin.
  const viaPublic = stub(redirect("http://cdn.example/feed.ics"), redirect("http://192.168.1.50/v3.ics"), ICS);
  assert.equal((await createGarbageFeed(viaPublic.fetcher).tomorrow("http://192.168.1.50/feed.ics", TZ, start))?.summary, "Green Bin and Recycling");
  assert.equal(viaPublic.calls.length, 3);
  assert.deepEqual(lines, [LOCAL, LOCAL]);
});

test("the configured link is trusted even on the LAN; a redirect to a public host or a public address is followed", async () => {
  const start = at("2026-10-04T12:00:00-03:00");
  for (const configured of ["http://192.168.1.50/feed.ics", "http://localhost:8080/feed.ics", "http://[fd00::5]/feed.ics"]) {
    const { fetcher, calls } = stub(ICS);
    assert.equal((await createGarbageFeed(fetcher).tomorrow(configured, TZ, start))?.summary, "Green Bin and Recycling", configured);
    assert.deepEqual(calls.map((c) => c.url), [configured]);
  }
  // Just outside each range, and public names that only look local.
  for (const location of ["https://172.32.0.1/f.ics", "https://172.15.255.255/f.ics", "https://100.128.0.1/f.ics", "https://100.63.255.255/f.ics", "https://192.169.0.1/f.ics", "https://11.0.0.1/f.ics", "https://1.0.0.1/f.ics", "https://169.255.0.1/f.ics", "https://[2001:db8::1]/f.ics", "https://[fec0::1]/f.ics", "https://[::ffff:8.8.8.8]/f.ics", "https://localhost.example/f.ics", "https://mylocalhost/f.ics", "https://cdn.example/f.ics"]) {
    const { fetcher, calls } = stub(redirect(location), ICS);
    assert.equal((await createGarbageFeed(fetcher).tomorrow(URL_, TZ, start))?.summary, "Green Bin and Recycling", location);
    assert.equal(calls.length, 2, location);
  }
});
