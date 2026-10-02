import { DEMO_MEMBERS } from "./demo.ts";
import { buildWeekPayload } from "./payload.ts";
import type { Config, MembersPayload, WeatherState, WeekPayload } from "./types.ts";
import { readEcWeather } from "./weather-ec.ts";
import { resolveMembers } from "./week.ts";

export type FamilyHandlerDeps = {
  /** Clock for family.week. Defaults to the time of the call. */
  now?: () => number;
  /** Environment Canada fetch. Defaults to the global fetch. */
  fetchWeather?: Parameters<typeof readEcWeather>[1];
};

/**
 * Handlers for the three registered queries. A tool declaration on one of
 * these operations would call this same function; none is declared here.
 */
export function familyHandlers(config: Config, deps: FamilyHandlerDeps = {}) {
  const now = deps.now ?? Date.now;
  const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
  return {
    "family.week": ({ start }: { start?: string }): Promise<WeekPayload> => buildWeekPayload(config, start, now(), readWeather),
    "family.members": (): MembersPayload => ({
      members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
    }),
    "family.weather": (): Promise<WeatherState> => readWeather(),
  };
}
