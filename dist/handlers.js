import { DEMO_MEMBERS } from "./demo.js";
import { buildWeekPayload } from "./payload.js";
import { readEcWeather } from "./weather-ec.js";
import { resolveMembers } from "./week.js";
/**
 * Handlers for the three registered queries. A tool declaration on one of
 * these operations would call this same function; none is declared here.
 */
export function familyHandlers(config, deps = {}) {
    const now = deps.now ?? Date.now;
    const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
    return {
        "family.week": ({ start }) => buildWeekPayload(config, start, now(), readWeather),
        "family.members": () => ({
            members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
        }),
        "family.weather": () => readWeather(),
    };
}
