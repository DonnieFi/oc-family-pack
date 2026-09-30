import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nearestFeature, parseCityPage, parseEcFeatures, readEcWeather } from "./weather-ec.ts";

const ottawa = JSON.parse(readFileSync(new URL("./fixtures/ec-ottawa.json", import.meta.url), "utf8")) as unknown;
const empty = { type: "FeatureCollection", features: [] };

test("picks the city page nearest the configured point and reads its conditions and forecast", () => {
  const nearest = nearestFeature(parseEcFeatures(ottawa), { lat: 45.42, lon: -75.7 });
  assert.ok(nearest);
  assert.deepEqual(parseCityPage(nearest), {
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
    sourceUrl: "https://weather.gc.ca/en/location/index.html?coords=45.4,-75.69",
  });
});

test("widens the search box until a city page appears", async () => {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    return Response.json(requested.length < 3 ? empty : ottawa);
  };
  const state = await readEcWeather({ lat: 45.9, lon: -76.9, label: "Cottage" }, fetcher, 1);
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("bbox")),
    ["-77.400,45.400,-76.400,46.400", "-78.400,44.400,-75.400,47.400", "-81.900,40.900,-71.900,50.900"],
  );
  assert.equal(state.status === "ok" && state.data.stationName, "Cottage");
});

test("a location outside Canada explains that weather covers Canada only", async () => {
  const state = await readEcWeather({ lat: 48.85, lon: 2.35 }, async () => Response.json(empty), 1);
  assert.deepEqual(state, {
    status: "unconfigured",
    hint: "No Environment Canada forecast found near this location. Weather currently covers Canada only.",
  });
});
