import { DEMO_MEMBERS } from "./demo.ts";
import { buildWeekPayload } from "./payload.ts";
import type { Config, MembersPayload, WeatherState, WeekPayload } from "./types.ts";
import type { Viewer } from "./visibility.ts";
import { readEcWeather } from "./weather-ec.ts";
import { resolveMembers } from "./week.ts";

export type FamilyHandlerDeps = {
  /** Clock for the week. Defaults to the time of the call. */
  now?: () => number;
  /** Environment Canada fetch. Defaults to the global fetch. */
  fetchWeather?: Parameters<typeof readEcWeather>[1];
};

/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config: Config, deps: FamilyHandlerDeps = {}) {
  const now = deps.now ?? Date.now;
  return ({ start }: { start?: string }, viewer: Viewer): Promise<WeekPayload> =>
    buildWeekPayload(config, start, now(), () => readEcWeather(config.location, deps.fetchWeather), viewer);
}

/**
 * Handlers for the two registered queries. A tool declaration on one of
 * these operations would call this same function; none is declared here.
 */
export function familyHandlers(config: Config, deps: FamilyHandlerDeps = {}) {
  const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
  return {
    "family.members": (): MembersPayload => ({
      members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
    }),
    "family.weather": (): Promise<WeatherState> => readWeather(),
  };
}
