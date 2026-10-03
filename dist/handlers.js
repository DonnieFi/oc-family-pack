import { DEMO_MEMBERS } from "./demo.js";
import { buildWeekPayload } from "./payload.js";
import { readEcWeather } from "./weather-ec.js";
import { resolveMembers } from "./week.js";
/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config, deps = {}) {
    const now = deps.now ?? Date.now;
    return ({ start }, viewer) => buildWeekPayload(config, start, now(), () => readEcWeather(config.location, deps.fetchWeather), viewer);
}
/**
 * Handlers for the two registered queries. A tool declaration on one of
 * these operations would call this same function; none is declared here.
 */
export function familyHandlers(config, deps = {}) {
    const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
    return {
        "family.members": () => ({
            members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
        }),
        "family.weather": () => readWeather(),
    };
}
