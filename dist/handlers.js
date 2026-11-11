import { DEMO_MEMBERS } from "./demo.js";
import { createGarbageFeed, garbageSchedule } from "./garbage.js";
import { buildWeekPayload } from "./payload.js";
import { buildSchedule, scheduleCaller } from "./schedule.js";
import { buildToday } from "./today.js";
import { readEcWeather } from "./weather-ec.js";
import { resolveRoster } from "./week.js";
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
    }, deps.identity);
}
/** Today for a page viewer resolved by the Gateway, using the same builder as the agent tool. */
export function familyTodayView(config, deps = {}) {
    const now = deps.now ?? Date.now;
    const garbage = createGarbageFeed(deps.fetchGarbage, deps.log ? { log: deps.log } : {});
    return (viewer) => buildToday(config, { viewer }, now(), {
        ...(deps.runGog === undefined ? {} : { runGog: deps.runGog }),
        garbage,
        ...(deps.identity === undefined ? {} : { identity: deps.identity }),
    });
}
/** Handlers for the registered queries. `family.schedule`, `family.today`, and `family.garbage` are also the agent's tools. */
export function familyHandlers(config, deps = {}) {
    const now = deps.now ?? Date.now;
    const garbage = createGarbageFeed(deps.fetchGarbage, deps.log ? { log: deps.log } : {});
    const readWeather = weatherReader(config, deps, now);
    const caller = (context) => scheduleCaller(config.demo ? DEMO_MEMBERS : config.members, context);
    return {
        "family.members": () => ({
            members: resolveRoster(config.demo ? DEMO_MEMBERS : config.members),
        }),
        "family.weather": () => readWeather(),
        "family.schedule": (input, context) => buildSchedule(config, input, caller(context), now(), deps.runGog, deps.identity),
        "family.today": (_input, context) => buildToday(config, caller(context), now(), {
            ...(deps.runGog === undefined ? {} : { runGog: deps.runGog }),
            garbage,
            ...(deps.identity === undefined ? {} : { identity: deps.identity }),
        }),
        "family.garbage": () => garbageSchedule(garbage, config, now()),
    };
}
