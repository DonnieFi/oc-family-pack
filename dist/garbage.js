import { GARBAGE_DAYS, GARBAGE_ITEMS_MAX } from "./contract.js";
import { addDays, localDate } from "./week.js";
// Ported from Bernie's bot/garbage_service.py, line for line where it can be.
/** Seven days: cities publish the schedule weeks ahead (garbage_service.py:11). */
const TTL_MS = 604_800_000;
const FETCH_TIMEOUT_MS = 8_000;
/** A city's year of pickups is tens of kilobytes; anything past 1 MiB is not a collection calendar. */
export const GARBAGE_BODY_MAX = 1_048_576;
const REDIRECTS_MAX = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ICONS = [
    ["garbage", "🗑️"],
    ["organics", "♻️"],
    ["recycling", "♻️"],
];
const NOT_CURBSIDE = ["depot", "clothing swap", "mobile hsw", "hsw event"];
export const GARBAGE_UNSET = "Garbage day isn't set up yet. Ask the person who set this up to add the city's collection calendar.";
export const GARBAGE_DOWN = "I couldn't get the garbage schedule just now. Try again in a bit.";
/** Bernie's tool line (tools/home.py:546). */
export const GARBAGE_NONE = "No upcoming garbage/recycling collections found.";
/** A read that failed for a reason we name ourselves; nothing from the URL or the server goes in it. */
class FeedFailure extends Error {
}
function icon(summary) {
    const s = summary.toLowerCase();
    return ICONS.find(([key]) => s.includes(key))?.[1] ?? "🚛";
}
function isCurbside(summary) {
    const s = summary.toLowerCase();
    return !NOT_CURBSIDE.some((word) => s.includes(word));
}
/** An RFC 5545 DATE. Python's strptime("%Y%m%d") also took six or seven digits; no feed sends those. */
function icsDate(value) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!match)
        return undefined;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date ? undefined : date;
}
/** Python's str.splitlines boundaries. */
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;
/** Dated events with a summary, sorted by date; anything else is skipped (garbage_service.py:38-60). */
export function parseIcs(text) {
    const unfolded = text.replaceAll("\r\n ", "").replaceAll("\r\n\t", "").replaceAll("\n ", "").replaceAll("\n\t", "");
    const events = [];
    let current = {};
    for (const line of unfolded.split(LINE_BREAK)) {
        if (line === "BEGIN:VEVENT") {
            current = {};
        }
        else if (line === "END:VEVENT") {
            if (current.date !== undefined && current.summary !== undefined)
                events.push({ date: current.date, summary: current.summary });
            current = {};
        }
        else if (line.startsWith("DTSTART")) {
            const date = icsDate((line.split(":").at(-1) ?? "").trim());
            if (date !== undefined)
                current.date = date;
        }
        else if (line.startsWith("SUMMARY:")) {
            current.summary = line.slice(8).replaceAll("\\,", ",");
        }
    }
    return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
/** Garbage, Green Bin and Recycling in that order, or Collection (garbage_service.py:63-81). */
function cleanSummary(summary) {
    const s = summary.toLowerCase();
    const parts = [];
    if (s.includes("garbage"))
        parts.push("Garbage");
    if (s.includes("organic") || s.includes("green"))
        parts.push("Green Bin");
    if (s.includes("recycl"))
        parts.push("Recycling");
    if (parts.length === 0)
        return "Collection";
    if (parts.length === 1)
        return parts[0];
    if (parts.length === 2)
        return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}
/**
 * The feed, cached in memory for seven days. A failed read serves the last copy, however old;
 * with no copy (a fresh start and the feed down) there is nothing. Callers asking at once share
 * one fetch (garbage_service.py:84-106).
 */
export function createGarbageFeed(fetcher = fetch, options = {}) {
    const cache = new Map();
    const pending = new Map();
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    /**
     * Bernie read status 200 only (garbage_service.py:97). Redirects are followed by hand: http(s) only, at most
     * three, never https to http, and never to a local address unless the hop has the configured link's own origin
     * (scheme, host and port), so a LAN feed may move to another path on itself but nowhere else on the LAN.
     */
    async function fetchCalendar(url, signal) {
        const trusted = URL.parse(url)?.origin;
        let target = url;
        for (let redirects = 0;; redirects += 1) {
            const response = await fetcher(target, { signal, redirect: "manual" });
            if (REDIRECT_STATUSES.has(response.status)) {
                void response.body?.cancel().catch(() => { });
                if (redirects >= REDIRECTS_MAX)
                    throw new FeedFailure("redirected more than three times");
                const location = response.headers.get("location");
                const next = location === null ? null : URL.parse(location, target);
                if (next?.protocol !== "https:" && next?.protocol !== "http:")
                    throw new FeedFailure("redirected somewhere other than an http(s) link");
                if (next.protocol === "http:" && URL.parse(target)?.protocol === "https:")
                    throw new FeedFailure("redirected from https to http");
                if (isLocalHost(next.hostname) && next.origin !== trusted)
                    throw new FeedFailure("redirected to a local address");
                target = next.href;
                continue;
            }
            if (response.status !== 200) {
                void response.body?.cancel().catch(() => { });
                throw new FeedFailure(`answered HTTP ${response.status}`);
            }
            const text = decode(await readCapped(response, signal));
            if (!/^BEGIN:VCALENDAR\r?$/m.test(text))
                throw new FeedFailure("did not send a calendar");
            return text;
        }
    }
    async function load(url, now) {
        const signal = AbortSignal.timeout(timeoutMs);
        try {
            const text = await fetchCalendar(url, signal);
            cache.set(url, { at: now, text });
            return text;
        }
        catch (error) {
            const reason = error instanceof FeedFailure ? error.message : signal.aborted ? "timed out" : "could not be reached";
            const stale = cache.get(url)?.text;
            options.log?.(`oc-family-pack: the garbage calendar ${reason}; ${stale === undefined ? "no garbage line until it answers" : "using the last copy"}`);
            return stale;
        }
    }
    function read(url, now) {
        const entry = cache.get(url);
        if (entry && now - entry.at < TTL_MS)
            return Promise.resolve(entry.text);
        let inFlight = pending.get(url);
        if (!inFlight) {
            inFlight = load(url, now).finally(() => pending.delete(url));
            pending.set(url, inFlight);
        }
        return inFlight;
    }
    /** Curbside pickups from today through today + days, in the family's zone; undefined when the feed was never read. */
    async function next(url, timezone, now, days) {
        const text = await read(url, now);
        if (text === undefined)
            return undefined;
        const today = localDate(now, timezone);
        const cutoff = addDays(today, days);
        return parseIcs(text)
            .filter((event) => today <= event.date && event.date <= cutoff && isCurbside(event.summary))
            .map((event) => ({ date: event.date, summary: cleanSummary(event.summary), icon: icon(event.summary) }));
    }
    /** Tomorrow's first pickup, for the daily brief. Undefined means leave the garbage line out. */
    async function tomorrow(url, timezone, now) {
        const date = addDays(localDate(now, timezone), 1);
        return (await next(url, timezone, now, 2))?.find((collection) => collection.date === date);
    }
    return { next, tomorrow };
}
const LOCAL_V4 = [
    [0x7f000000, 8], // 127/8 loopback
    [0x0a000000, 8], // 10/8
    [0xac100000, 12], // 172.16/12
    [0xc0a80000, 16], // 192.168/16
    [0xa9fe0000, 16], // 169.254/16 link-local, cloud metadata
    [0x64400000, 10], // 100.64/10 carrier-grade NAT
    [0x00000000, 8], // 0/8
];
function localV4(address) {
    return LOCAL_V4.some(([base, bits]) => (address >>> (32 - bits)) === base >>> (32 - bits));
}
function v4(text) {
    const parts = text.split(".");
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255))
        return undefined;
    return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}
/** Eight 16-bit groups. The URL parser has already compressed the address and written any IPv4 tail in hex. */
function v6(text) {
    const [head, rest] = text.split("::");
    const groups = (part) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN)));
    const left = groups(head);
    const right = rest === undefined ? [] : groups(rest);
    const fill = 8 - left.length - right.length;
    if (fill < 0 || (rest === undefined && fill !== 0))
        return undefined;
    const all = [...left, ...Array(fill).fill(0), ...right];
    return all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? all : undefined;
}
/**
 * A redirect hop to this host is refused: the configured link is trusted (it may be on the LAN), and so
 * is a hop with its exact origin; any other hop is not. Only literal addresses and localhost names are checked; a public name that resolves to a LAN
 * address is the accepted gap. `hostname` is WHATWG-parsed, so 2130706433 and 0x7f.1 arrive as 127.0.0.1.
 */
export function isLocalHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost"))
        return true;
    const address = v4(host);
    if (address !== undefined)
        return localV4(address);
    if (!host.includes(":"))
        return false;
    const groups = v6(host);
    if (!groups)
        return true; // an address the parser accepted but we can't read is not followed
    const [first] = groups;
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] <= 1)
        return true; // :: and ::1
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80)
        return true; // fc00::/7, fe80::/10
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
        return localV4(groups[6] * 65536 + groups[7]); // ::ffff:a.b.c.d
    return false;
}
/** The body, a chunk at a time, abandoned past the cap whatever Content-Length said, or when the timeout fires mid-body. */
async function readCapped(response, signal) {
    const reader = response.body?.getReader();
    if (!reader)
        return new Uint8Array();
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
            if (size > GARBAGE_BODY_MAX)
                throw new FeedFailure("sent more than 1 MiB");
            chunks.push(value);
        }
    }
    catch (error) {
        void reader.cancel().catch(() => { });
        throw error;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
function decode(bytes) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        throw new FeedFailure("did not send UTF-8 text");
    }
}
const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "2-digit" });
/** Bernie's "%A, %b %d": "Monday, Oct 05". */
function dayLabel(date) {
    const parts = Object.fromEntries(dayFormat.formatToParts(Date.parse(`${date}T12:00:00Z`)).map((part) => [part.type, part.value]));
    return `${parts.weekday}, ${parts.month} ${parts.day}`;
}
/** The `garbage_schedule` tool: pickups for today and the next 14 days (tools/home.py:533-551). */
export async function garbageSchedule(feed, config, now) {
    if (config.garbageIcsUrl === undefined)
        return { error: GARBAGE_UNSET };
    const collections = await feed.next(config.garbageIcsUrl, config.timezone, now, GARBAGE_DAYS);
    if (collections === undefined)
        return { error: GARBAGE_DOWN };
    if (collections.length === 0)
        return { note: GARBAGE_NONE };
    return { collections: collections.slice(0, GARBAGE_ITEMS_MAX).map((collection) => ({ date: dayLabel(collection.date), what: collection.summary })) };
}
