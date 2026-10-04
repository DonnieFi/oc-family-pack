import { WEATHER_CACHE_MINUTES } from "./contract.js";
import { precipFromCondition, recommend, roundHalfEven } from "./recommendation.js";
const ENDPOINT = "https://api.weather.gc.ca/collections/citypageweather-realtime/items";
/** A five-degree box can land on a station hundreds of kilometres away, so the search stops at 1.5. */
const BBOX_STEPS = [0.5, 1.5];
const FETCH_TIMEOUT_MS = 10_000;
/** Five city pages, French and English, run to a few hundred kilobytes; past 4 MiB it is not a forecast. */
export const WEATHER_BODY_MAX = 4 * 1_048_576;
/** The card links Environment Canada's home page: the citypage link carries the station's coordinates. */
export const WEATHER_SOURCE_URL = "https://weather.gc.ca/";
const FORECAST_PERIODS = 4;
/** Bernie took a station only if it had reported in the last 12 hours (weather_service.py:509). */
const OBSERVATION_MAX_AGE_MS = 12 * 3_600_000;
/** Bernie read the first 24 hourly forecasts (weather_service.py:551). */
const HOURLY_MAX = 24;
export const WEATHER_SETUP_HINT = "Add location { lat, lon } to the plugin config to show local weather.";
export const WEATHER_STALE_MESSAGE = "No Environment Canada station near this location has reported in the last 12 hours.";
export const WEATHER_CANADA_ONLY_HINT = "No Environment Canada forecast found near this location. Weather currently covers Canada only.";
/** A read that failed for a reason we name ourselves; nothing from the URL or the server goes in it. */
class FeedFailure extends Error {
}
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
/** A number, or a numeric string: the citypage schema types wind speed as a string (Bernie's float()). */
function englishNumeric(value, ...path) {
    const found = at(value, ...path, "en");
    const number = typeof found === "string" && found.trim() !== "" ? Number(found) : found;
    return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}
/** When the station last reported, from currentConditions.timestamp; undefined if absent or unreadable. */
export function observedTime(feature) {
    const stamp = englishText(feature.properties, "currentConditions", "timestamp");
    const time = stamp === undefined ? Number.NaN : Date.parse(stamp);
    return Number.isNaN(time) ? undefined : time;
}
/** The hourly forecast as local hours and chances, as _parse_ec_current built it (weather_service.py:550-565). */
function hourlyChances(props, timezone) {
    const list = at(props, "hourlyForecastGroup", "hourlyForecasts");
    const hourOf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" });
    return (Array.isArray(list) ? list.slice(0, HOURLY_MAX) : []).flatMap((entry) => {
        const stamp = at(entry, "timestamp");
        const time = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
        const lop = at(entry, "lop", "value", "en") === undefined ? 0 : englishNumeric(entry, "lop", "value");
        if (Number.isNaN(time) || englishNumeric(entry, "temperature", "value") === undefined || lop === undefined)
            return [];
        return [{ hour: Number(hourOf.format(time)), precipProbPct: roundHalfEven(lop) }];
    });
}
export function parseEcFeatures(raw) {
    const features = at(raw, "features");
    if (!Array.isArray(features)) {
        throw new FeedFailure("Environment Canada returned no features list");
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
export function parseCityPage(feature, timezone) {
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
        sourceUrl: WEATHER_SOURCE_URL,
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
    const windKmh = englishNumeric(current, "wind", "speed", "value");
    if (windKmh !== undefined)
        card.windKmh = roundHalfEven(windKmh);
    if (tempC !== undefined) {
        card.recommendation = recommend({
            tempC: roundHalfEven(tempC),
            ...(condition ? { condition } : {}),
            windKmh: card.windKmh ?? 0,
            precipProbPct: precipFromCondition(condition),
            hourly: hourlyChances(props, timezone),
        });
    }
    return card;
}
function clampLat(value) {
    return Math.min(90, Math.max(-90, value));
}
export function bboxUrl(location, radius) {
    const box = [location.lon - radius, clampLat(location.lat - radius), location.lon + radius, clampLat(location.lat + radius)]
        .map((value) => value.toFixed(3))
        .join(",");
    return `${ENDPOINT}?f=json&bbox=${box}&limit=5`;
}
/** The body, a chunk at a time, abandoned past the cap whatever Content-Length said, or when the timeout fires mid-body. */
async function readCapped(response, signal) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new FeedFailure("sent no body");
    const aborted = new Promise((_, reject) => {
        if (signal.aborted)
            reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => { });
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done)
                break;
            size += value.byteLength;
            if (size > WEATHER_BODY_MAX)
                throw new FeedFailure("sent more than 4 MiB");
            chunks.push(value);
        }
    }
    catch (error) {
        void reader.cancel().catch(() => { });
        throw error;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    }
    catch {
        throw new FeedFailure("did not send UTF-8 text");
    }
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new FeedFailure("did not send JSON");
    }
}
async function lookup(location, fetcher, now, options) {
    const point = { ...location, lat: clampLat(location.lat) };
    let stale = false;
    for (const radius of BBOX_STEPS) {
        const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
        // The endpoint is fixed and does not redirect; a redirect is refused rather than followed somewhere else.
        const response = await fetcher(bboxUrl(point, radius), {
            signal,
            redirect: "error",
            headers: { Accept: "application/geo+json, application/json" },
        });
        if (!response.ok) {
            void response.body?.cancel().catch(() => { });
            return { status: "error", message: `Environment Canada returned HTTP ${response.status}. Try again shortly.` };
        }
        const features = parseEcFeatures(parseJson(await readCapped(response, signal)));
        const recent = features.filter((feature) => {
            const observed = observedTime(feature);
            return observed !== undefined && now - observed < OBSERVATION_MAX_AGE_MS;
        });
        stale ||= features.length > recent.length;
        const nearest = nearestFeature(recent, point);
        if (nearest) {
            const card = parseCityPage(nearest, options.timezone);
            return { status: "ok", data: location.label ? { ...card, stationName: location.label } : card };
        }
    }
    return stale ? { status: "error", message: WEATHER_STALE_MESSAGE } : { status: "unconfigured", hint: WEATHER_CANADA_ONLY_HINT };
}
const cache = new Map();
export async function readEcWeather(location, fetcher = fetch, now = Date.now(), options = { timezone: "UTC" }) {
    if (!location) {
        return { status: "unconfigured", hint: WEATHER_SETUP_HINT };
    }
    const key = `${location.lat},${location.lon},${location.label ?? ""},${options.timezone}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now) {
        return cached.state;
    }
    let state;
    try {
        state = await lookup(location, fetcher, now, options);
    }
    catch (error) {
        // Fixed words only: a fetch error's message can carry the request URL, and with it the household's coordinates.
        const reason = error instanceof Error && error.name === "TimeoutError"
            ? "timed out"
            : error instanceof FeedFailure
                ? "sent something that isn't a forecast"
                : "was unreachable";
        return { status: "error", message: `Environment Canada ${reason}. Weather will retry on the next refresh.` };
    }
    if (state.status !== "error") {
        cache.set(key, { expires: now + WEATHER_CACHE_MINUTES * 60_000, state });
    }
    return state;
}
