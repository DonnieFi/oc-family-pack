import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Value } from "typebox/value";
import { WeatherStateSchema } from "./contract.ts";
import { roundHalfEven } from "./recommendation.ts";
import { bboxUrl, nearestFeature, parseCityPage, parseEcFeatures, readEcWeather, WEATHER_BODY_MAX, WEATHER_STALE_MESSAGE, type EcFeature } from "./weather-ec.ts";

const ottawa = JSON.parse(readFileSync(new URL("./fixtures/ec-ottawa.json", import.meta.url), "utf8")) as unknown;
const empty = { type: "FeatureCollection", features: [] };

test("picks the city page nearest the configured point and reads its conditions and forecast", () => {
  const nearest = nearestFeature(parseEcFeatures(ottawa), { lat: 45.42, lon: -75.7 });
  assert.ok(nearest);
  assert.deepEqual(parseCityPage(nearest, "America/Toronto"), {
    stationName: "Ottawa (Kanata - Orléans)",
    observedAt: "2026-09-30T18:10:00Z",
    tempC: 15.9,
    condition: "Mostly Cloudy",
    highC: 21,
    lowC: 15,
    forecast: [
      { period: "Today", summary: "Periods of drizzle · High 21°" },
      { period: "Tonight", summary: "Mainly cloudy · Low 15°" },
      { period: "Thursday", summary: "Chance of showers · High 21°" },
      { period: "Thursday night", summary: "Chance of showers · Low 14°" },
    ],
    sourceUrl: "https://weather.gc.ca/",
    recommendation: { summary: "Mostly Cloudy · 16°C.", clothing: [], alerts: ["Dry day expected — good for being outside"], severity: "low" },
  });
});

test("widens the search box until a city page appears", async () => {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    return Response.json(requested.length < 2 ? empty : ottawa);
  };
  const state = await readEcWeather({ lat: 45.9, lon: -76.9, label: "Cottage" }, fetcher, 1);
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("bbox")),
    ["-77.400,45.400,-76.400,46.400", "-78.400,44.400,-75.400,47.400"],
  );
  assert.equal(state.status === "ok" && state.data.stationName, "Cottage");
});

test("a search box near a pole stays within latitude 90", () => {
  assert.equal(new URL(bboxUrl({ lat: 89.2, lon: -75 }, 1.5)).searchParams.get("bbox"), "-76.500,87.700,-73.500,90.000");
  assert.equal(new URL(bboxUrl({ lat: -89.2, lon: -75 }, 1.5)).searchParams.get("bbox"), "-76.500,-90.000,-73.500,-87.700");
});

test("a location outside Canada explains that weather covers Canada only", async () => {
  const state = await readEcWeather({ lat: 48.85, lon: 2.35 }, async () => Response.json(empty), 1);
  assert.deepEqual(state, {
    status: "unconfigured",
    hint: "No Environment Canada forecast found near this location. Weather currently covers Canada only.",
  });
});

/** What Bernie's own _parse_ec_current and get_recommendations returned (~/ocfp-share/runs/s5k.20-bernie-golden.py). */
type Advice = { summary: string; clothing: string[]; alerts: string[]; severity: string };
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/weather-golden.json", import.meta.url), "utf8")) as {
  timezone: string;
  cases: { name: string; feature: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }; parsed: { wind_kmh: number }; bernie: Advice; intended?: Advice & { why: string } }[];
};
const asFeature = (raw: (typeof GOLDEN.cases)[number]["feature"]): EcFeature => ({ lon: raw.geometry.coordinates[0], lat: raw.geometry.coordinates[1], properties: raw.properties });

test("the recommendation on the card is what Bernie's engine said for every golden case but one", () => {
  for (const golden of GOLDEN.cases) {
    const card = parseCityPage(asFeature(golden.feature), GOLDEN.timezone);
    const { why: _why, ...intended } = golden.intended ?? { why: "" };
    assert.deepEqual(card.recommendation, golden.intended ? intended : golden.bernie, golden.name);
    assert.equal(card.windKmh ?? 0, golden.parsed.wind_kmh, golden.name);
  }
});

test("the one intended difference: wind over 40 km/h adds a windproof layer, where Bernie's engine read a key nothing set", () => {
  const differing = GOLDEN.cases.filter((golden) => golden.intended);
  assert.deepEqual(differing.map((golden) => golden.name), ["wind 41 (the one intended difference)"]);
  const [wind] = differing;
  assert.deepEqual(wind!.bernie.clothing, ["jacket"]);
  assert.deepEqual(wind!.intended!.clothing, ["jacket", "windproof layer"]);
  assert.equal(wind!.intended!.summary, "Mostly Cloudy · 5°C. Bring: jacket and windproof layer.");
  assert.equal(wind!.intended!.severity, "medium");
});

test("readings round half to even, as Python's round() does", () => {
  assert.deepEqual([14.5, 2.5, 0.5, -0.5, -10.5, 15.5, 7.5, -12.5, 3.2, -3.7].map(roundHalfEven), [14, 2, 0, 0, -10, 16, 8, -12, 3, -4]);
});

test("rain hours are read in the household's zone, not the Gateway's or UTC", () => {
  const evening = GOLDEN.cases.find((golden) => golden.name === "rain this evening (6pm)")!;
  assert.deepEqual(parseCityPage(asFeature(evening.feature), "America/Halifax").recommendation?.alerts, ["Rain likely this evening (6pm) (~61% chance)"]);
  assert.deepEqual(parseCityPage(asFeature(evening.feature), "America/Vancouver").recommendation?.alerts, ["Rain likely this afternoon (2pm) (~61% chance)"]);
  assert.deepEqual(parseCityPage(asFeature(evening.feature), "UTC").recommendation?.alerts, ["Rain likely tonight (9pm) (~61% chance)"]);
});

test("wind speed comes as a number or the numeric string the citypage schema declares; anything else is no reading", () => {
  const base = asFeature(GOLDEN.cases.find((golden) => golden.name === "wind 41 (the one intended difference)")!.feature);
  const withWind = (value: unknown) => {
    const current = structuredClone(base.properties.currentConditions) as { wind: { speed: { value: { en: unknown } } } };
    current.wind.speed.value.en = value;
    return parseCityPage({ ...base, properties: { ...base.properties, currentConditions: current } }, "America/Halifax");
  };
  assert.equal(withWind("41").windKmh, 41);
  assert.equal(withWind("40.5").windKmh, 40);
  assert.equal(withWind(41.6).recommendation?.clothing.includes("windproof layer"), true);
  assert.equal(withWind("calm").windKmh, undefined);
  assert.deepEqual(withWind("").recommendation?.clothing, ["jacket"]);
});

const fresh = (observed: string, name: string) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-63.57, 44.65] }, properties: { name: { en: name }, currentConditions: { timestamp: { en: observed }, temperature: { value: { en: 4 } } } } }],
});

test("a station that has not reported in 12 hours is skipped for one farther out; with none, the card is an error and is not cached", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const requested: string[] = [];
  const answers = [fresh("2026-10-04T00:00:00Z", "Stale"), fresh("2026-10-04T00:00:01Z", "Fresh")];
  const state = await readEcWeather({ lat: 44.1, lon: -63.1 }, async (url) => (requested.push(url), Response.json(answers[requested.length - 1])), now, { timezone: "America/Halifax" });
  assert.equal(state.status === "ok" && state.data.stationName, "Fresh");
  assert.equal(requested.length, 2);

  let calls = 0;
  const stale = async () => (calls++, Response.json(fresh("2026-10-03T23:59:59Z", "Stale")));
  assert.deepEqual(await readEcWeather({ lat: 44.2, lon: -63.2 }, stale, now, { timezone: "America/Halifax" }), { status: "error", message: WEATHER_STALE_MESSAGE });
  assert.equal(calls, 2);
  await readEcWeather({ lat: 44.2, lon: -63.2 }, stale, now + 60_000, { timezone: "America/Halifax" });
  assert.equal(calls, 4, "a stale answer is asked again next time");
  assert.equal(Value.Check(WeatherStateSchema, state), true);
});

test("one reading is reused for 30 minutes (Bernie's 1800 s): a hit at 29 min, a fresh read at 31", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const location = { lat: 44.3, lon: -63.3 };
  const options = { timezone: "America/Halifax" };
  let calls = 0;
  const fetcher = async () => (calls++, Response.json(fresh("2026-10-04T11:50:00Z", "Halifax")));
  await readEcWeather(location, fetcher, now, options);
  await readEcWeather(location, fetcher, now + 29 * 60_000, options);
  await readEcWeather(location, fetcher, now + 30 * 60_000 - 1, options);
  assert.equal(calls, 1);
  await readEcWeather(location, fetcher, now + 31 * 60_000, options);
  assert.equal(calls, 2);
  // The 31-minute read starts a new 30 minutes.
  await readEcWeather(location, fetcher, now + 60 * 60_000, options);
  assert.equal(calls, 2);
  await readEcWeather(location, fetcher, now + 62 * 60_000, options);
  assert.equal(calls, 3);
});

test("with Environment Canada down and nothing read since the restart there is no card, only the error", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const down = await readEcWeather({ lat: 44.5, lon: -63.5 }, async () => new Response("busy", { status: 503 }), now, { timezone: "America/Halifax" });
  assert.equal(down.status, "error");
  assert.equal("data" in down, false);
  const unreachable = await readEcWeather({ lat: 44.6, lon: -63.6 }, async () => { throw new TypeError("fetch failed"); }, now, { timezone: "America/Halifax" });
  assert.deepEqual(unreachable, { status: "error", message: "Environment Canada was unreachable. Weather will retry on the next refresh." });
});

const HALIFAX = { timezone: "America/Halifax" };
const NOT_A_FORECAST = { status: "error", message: "Environment Canada sent something that isn't a forecast. Weather will retry on the next refresh." };
let spot = 0;
/** A location no other test has cached (the cache lives for the process). */
const place = () => ({ lat: 46 + (spot += 0.01), lon: -64 });

/** A body pulled chunk by chunk, counting what was pulled and whether it was cancelled. */
function pulled(bytes: number, headers: Record<string, string> = {}) {
  const CHUNK = 65_536;
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= bytes) return controller.close();
        const chunk = new Uint8Array(Math.min(CHUNK, bytes - seen.pulled)).fill(0x20);
        if (seen.pulled === 0) chunk.set(new TextEncoder().encode('{"features":['));
        seen.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, CHUNK, response: () => new Response(body, { status: 200, headers }) };
}

test("a body past 4 MiB is cut off whatever Content-Length says, is an error, and is not cached", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  for (const headers of [{}, { "content-length": "100" }]) {
    const big = pulled(2 * WEATHER_BODY_MAX, headers);
    const where = place();
    assert.deepEqual(await readEcWeather(where, async () => big.response(), now, HALIFAX), NOT_A_FORECAST);
    assert.ok(big.seen.pulled <= WEATHER_BODY_MAX + big.CHUNK && big.seen.cancelled, `pulled ${big.seen.pulled}`);
    const good = await readEcWeather(where, async () => Response.json(fresh("2026-10-04T11:00:00Z", "Halifax")), now + 1, HALIFAX);
    assert.equal(good.status === "ok" && good.data.stationName, "Halifax", "the failure was not cached");
  }
});

test("a read that hangs, before or during the body, times out as an error and is not cached", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const hang = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const stall = async () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")), pull: () => new Promise(() => {}) }), { status: 200 });
  for (const fetcher of [hang, stall]) {
    const where = place();
    const started = performance.now();
    assert.deepEqual(await readEcWeather(where, fetcher, now, { ...HALIFAX, timeoutMs: 50 }), { status: "error", message: "Environment Canada timed out. Weather will retry on the next refresh." });
    assert.ok(performance.now() - started < 2_000);
    const good = await readEcWeather(where, async () => Response.json(fresh("2026-10-04T11:00:00Z", "Halifax")), now + 1, HALIFAX);
    assert.equal(good.status, "ok");
  }
});

test("a body that is not a UTF-8 JSON feature list is an error and is never cached", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const bad = [
    () => new Response("<html>maintenance</html>", { status: 200 }),
    // Valid JSON around one byte that is not UTF-8: decoded leniently it would parse as an empty list.
    () => new Response(Buffer.concat([Buffer.from('{"features":[],"name":"'), Buffer.from([0xff]), Buffer.from('"}')]), { status: 200 }),
    () => Response.json({ type: "FeatureCollection" }),
    () => new Response(null, { status: 200 }),
  ];
  for (const answer of bad) {
    const where = place();
    let calls = 0;
    assert.deepEqual(await readEcWeather(where, async () => (calls++, answer()), now, HALIFAX), NOT_A_FORECAST);
    const good = await readEcWeather(where, async () => (calls++, Response.json(fresh("2026-10-04T11:00:00Z", "Halifax"))), now + 1, HALIFAX);
    assert.equal(good.status, "ok");
    assert.equal(calls, 2);
  }
});

test("over real HTTP: redirects are refused, a chunked 5 MiB body is cut off, and a good answer is read", async () => {
  let written = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) return void res.writeHead(302, { location: "/good" }).end();
    if (req.url?.startsWith("/big")) {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(65_536, 0x20);
      const pump = () => {
        while (written < 5 * 1_048_576 && !res.destroyed) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fresh("2026-10-04T11:00:00Z", "Loopback")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const via = (path: string) => (url: string, init: Parameters<typeof fetch>[1]) => fetch(`${base}${path}${new URL(url).search}`, init);
  try {
    const now = Date.parse("2026-10-04T12:00:00Z");
    assert.deepEqual(await readEcWeather(place(), via("/redirect"), now, HALIFAX), { status: "error", message: "Environment Canada was unreachable. Weather will retry on the next refresh." });
    assert.deepEqual(await readEcWeather(place(), via("/big"), now, HALIFAX), NOT_A_FORECAST);
    const good = await readEcWeather(place(), via("/good"), now, HALIFAX);
    assert.equal(good.status === "ok" && good.data.stationName, "Loopback");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("no reply carries the request URL or the household's coordinates, and nothing is logged", async (t) => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const logged: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => logged.push(args));
  const answers: [string, (url: string, init: { signal: AbortSignal }) => Promise<Response>][] = [
    ["ok", async () => Response.json(ottawa)],
    ["timeout", (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))],
    ["503 echoing the URL", async (url) => new Response(url, { status: 503 })],
    ["refused redirect", async (url) => { throw new TypeError(`fetch failed: redirect from ${url}`); }],
    ["oversize", async () => pulled(2 * WEATHER_BODY_MAX).response()],
    ["parse error echoing the URL", async (url) => new Response(`not json ${url}`, { status: 200 })],
    ["thrown with the URL", async (url) => { throw new TypeError(`getaddrinfo ENOTFOUND api.weather.gc.ca ${url}`); }],
    ["stale", async () => Response.json(fresh("2026-10-03T00:00:00Z", "Old"))],
  ];
  for (const [name, fetcher] of answers) {
    const where = { lat: 45.4215 + (spot += 0.0001), lon: -75.6972 };
    // The Ottawa fixture was read at 18:10 UTC on Sep 30; its citypage url carries coords=45.4,-75.69.
    const state = await readEcWeather(where, fetcher, name === "ok" ? Date.parse("2026-09-30T18:30:00Z") : now, { ...HALIFAX, timeoutMs: 50 });
    assert.equal(state.status, name === "ok" ? "ok" : "error", name);
    const reply = JSON.stringify(state);
    for (const part of [String(where.lat), "45.42", "-75.69", "75.6972", "coords=", "bbox", "api.weather.gc.ca", "citypageweather", "?f=json"]) {
      assert.ok(!reply.includes(part), `${name}: "${part}" in ${reply}`);
    }
  }
  assert.deepEqual(logged, []);
});
