import { DEMO_MEMBERS } from "./demo.js";
import { createGarbageFeed, garbageSchedule } from "./garbage.js";
import { buildWeekPayload } from "./payload.js";
import { buildSchedule, scheduleCaller } from "./schedule.js";
import { readEcWeather } from "./weather-ec.js";
import { resolveMembers } from "./week.js";
/** The Environment Canada card for the configured location, in the household's zone, cached for 30 minutes. */
function weatherReader(config, deps, now) {
    return () => readEcWeather(config.location, deps.fetchWeather, now(), { timezone: config.timezone });
}
/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config, deps = {}) {
    const now = deps.now ?? Date.now;
    const readWeather = weatherReader(config, deps, now);
    return ({ start }, viewer, canEdit = false) => buildWeekPayload(config, start, now(), readWeather, viewer, {
        canEdit,
        grantReadOnly: deps.grant?.get() === "read-only",
    });
}
/** Handlers for the registered queries. `family.schedule` and `family.garbage` are also the agent's `family_schedule` and `garbage_schedule` tools. */
export function familyHandlers(config, deps = {}) {
    const now = deps.now ?? Date.now;
    const garbage = createGarbageFeed(deps.fetchGarbage, deps.log ? { log: deps.log } : {});
    const readWeather = weatherReader(config, deps, now);
    return {
        "family.members": () => ({
            members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
        }),
        "family.weather": () => readWeather(),
        "family.schedule": (input, context) => buildSchedule(config, input, scheduleCaller(config.demo ? DEMO_MEMBERS : config.members, context), now(), deps.runGog),
        "family.garbage": () => garbageSchedule(garbage, config, now()),
    };
}
