import { DEMO_MEMBERS } from "./demo.js";
import { buildWeekPayload } from "./payload.js";
import { buildSchedule, scheduleCaller } from "./schedule.js";
import { readEcWeather } from "./weather-ec.js";
import { resolveMembers } from "./week.js";
/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config, deps = {}) {
    const now = deps.now ?? Date.now;
    return ({ start }, viewer, canEdit = false) => buildWeekPayload(config, start, now(), () => readEcWeather(config.location, deps.fetchWeather), viewer, {
        canEdit,
        grantReadOnly: deps.grant?.get() === "read-only",
    });
}
/** Handlers for the registered queries. `family.schedule` is also the agent's `family_schedule` tool. */
export function familyHandlers(config, deps = {}) {
    const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
    const now = deps.now ?? Date.now;
    return {
        "family.members": () => ({
            members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
        }),
        "family.weather": () => readWeather(),
        "family.schedule": (input, context) => buildSchedule(config, input, scheduleCaller(config.demo ? DEMO_MEMBERS : config.members, context), now(), deps.runGog),
    };
}
