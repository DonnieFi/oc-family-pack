const ENDPOINT = "https://api.weather.gc.ca/collections/citypageweather-realtime/items";
const BBOX_STEPS = [0.5, 1.5, 5];
const CACHE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const FORECAST_PERIODS = 4;
export const WEATHER_SETUP_HINT = "Add location { lat, lon } to the plugin config to show local weather.";
export const WEATHER_CANADA_ONLY_HINT = "No Environment Canada forecast found near this location. Weather currently covers Canada only.";
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function at(value, ...path) {
    let current = value;
    for (const key of path) {
        current = record(current)?.[key];
    }
    return current;
}
function englishText(value, ...path) {
    const found = at(value, ...path, "en");
    return typeof found === "string" && found.trim() ? found.trim() : undefined;
}
function englishNumber(value, ...path) {
    const found = at(value, ...path, "en");
    return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}
export function parseEcFeatures(raw) {
    const features = at(raw, "features");
    if (!Array.isArray(features)) {
        throw new Error("Environment Canada returned no features list");
    }
    return features.flatMap((feature) => {
        const coordinates = at(feature, "geometry", "coordinates");
        const properties = record(at(feature, "properties"));
        if (!Array.isArray(coordinates) || !properties) {
            return [];
        }
        const [lon, lat] = coordinates;
        return typeof lon === "number" && typeof lat === "number" ? [{ lon, lat, properties }] : [];
    });
}
export function nearestFeature(features, location) {
    const scale = Math.cos((location.lat * Math.PI) / 180);
    const distance = (feature) => ((feature.lon - location.lon) * scale) ** 2 + (feature.lat - location.lat) ** 2;
    return features.toSorted((a, b) => distance(a) - distance(b))[0];
}
function periodTemperatures(forecast) {
    const list = at(forecast, "temperatures", "temperature");
    return Array.isArray(list)
        ? list.map((entry) => {
            const temperature = {};
            const kind = englishText(entry, "class");
            const value = englishNumber(entry, "value");
            if (kind)
                temperature.kind = kind;
            if (value !== undefined)
                temperature.value = value;
            return temperature;
        })
        : [];
}
export function parseCityPage(feature) {
    const props = feature.properties;
    const current = props.currentConditions;
    const forecasts = at(props, "forecastGroup", "forecasts");
    const periods = Array.isArray(forecasts) ? forecasts : [];
    const firstOf = (kind) => periods.flatMap(periodTemperatures).find((temperature) => temperature.kind === kind)?.value;
    const card = {
        stationName: englishText(props, "name") ?? "Nearby forecast",
        forecast: periods.slice(0, FORECAST_PERIODS).flatMap((period) => {
            const name = englishText(period, "period", "textForecastName");
            const sky = englishText(period, "abbreviatedForecast", "textSummary");
            const temperature = periodTemperatures(period)[0];
            if (!name || !sky) {
                return [];
            }
            const suffix = temperature?.value === undefined ? "" : ` · ${temperature.kind === "low" ? "Low" : "High"} ${temperature.value}°`;
            return [{ period: name, summary: `${sky}${suffix}` }];
        }),
        sourceUrl: englishText(props, "url") ?? "https://weather.gc.ca/",
    };
    const observedAt = englishText(current, "timestamp");
    const tempC = englishNumber(current, "temperature", "value");
    const condition = englishText(current, "condition");
    const highC = firstOf("high");
    const lowC = firstOf("low");
    if (observedAt)
        card.observedAt = observedAt;
    if (tempC !== undefined)
        card.tempC = tempC;
    if (condition)
        card.condition = condition;
    if (highC !== undefined)
        card.highC = highC;
    if (lowC !== undefined)
        card.lowC = lowC;
    return card;
}
export function bboxUrl(location, radius) {
    const box = [location.lon - radius, location.lat - radius, location.lon + radius, location.lat + radius]
        .map((value) => value.toFixed(3))
        .join(",");
    return `${ENDPOINT}?f=json&bbox=${box}&limit=5`;
}
async function lookup(location, fetcher) {
    for (const radius of BBOX_STEPS) {
        const response = await fetcher(bboxUrl(location, radius), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { Accept: "application/geo+json, application/json" },
        });
        if (!response.ok) {
            return { status: "error", message: `Environment Canada returned HTTP ${response.status}. Try again shortly.` };
        }
        const nearest = nearestFeature(parseEcFeatures(await response.json()), location);
        if (nearest) {
            const card = parseCityPage(nearest);
            return { status: "ok", data: location.label ? { ...card, stationName: location.label } : card };
        }
    }
    return { status: "unconfigured", hint: WEATHER_CANADA_ONLY_HINT };
}
const cache = new Map();
export async function readEcWeather(location, fetcher = fetch, now = Date.now()) {
    if (!location) {
        return { status: "unconfigured", hint: WEATHER_SETUP_HINT };
    }
    const key = `${location.lat},${location.lon},${location.label ?? ""}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now) {
        return cached.state;
    }
    let state;
    try {
        state = await lookup(location, fetcher);
    }
    catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "was unreachable";
        return { status: "error", message: `Environment Canada ${reason}. Weather will retry on the next refresh.` };
    }
    if (state.status !== "error") {
        cache.set(key, { expires: now + CACHE_MS, state });
    }
    return state;
}
