import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import type { GrantHolder } from "./grant.ts";
import { DEMO_MEMBERS } from "./demo.ts";
import { buildWeekPayload } from "./payload.ts";
import { buildSchedule, scheduleCaller } from "./schedule.ts";
import type { Config, MembersPayload, ScheduleInput, ScheduleOutput, WeatherState, WeekPayload } from "./types.ts";
import type { Viewer } from "./visibility.ts";
import { readEcWeather } from "./weather-ec.ts";
import { resolveMembers } from "./week.ts";

export type FamilyHandlerDeps = {
  /** Clock for the week. Defaults to the time of the call. */
  now?: () => number;
  /** Environment Canada fetch. Defaults to the global fetch. */
  fetchWeather?: Parameters<typeof readEcWeather>[1];
  /** gog runner for the schedule tool. Defaults to the real binary. */
  runGog?: RunGog;
  /** The Google grant, for the page's read-only notice. */
  grant?: Pick<GrantHolder, "get">;
};

/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config: Config, deps: FamilyHandlerDeps = {}) {
  const now = deps.now ?? Date.now;
  return ({ start }: { start?: string }, viewer: Viewer, canEdit = false): Promise<WeekPayload> =>
    buildWeekPayload(config, start, now(), () => readEcWeather(config.location, deps.fetchWeather), viewer, {
      canEdit,
      grantReadOnly: deps.grant?.get() === "read-only",
    });
}

/** Handlers for the registered queries. `family.schedule` is also the agent's `family_schedule` tool. */
export function familyHandlers(config: Config, deps: FamilyHandlerDeps = {}) {
  const readWeather = () => readEcWeather(config.location, deps.fetchWeather);
  const now = deps.now ?? Date.now;
  return {
    "family.members": (): MembersPayload => ({
      members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
    }),
    "family.weather": (): Promise<WeatherState> => readWeather(),
    "family.schedule": (input: ScheduleInput, context: FeatureInvocationContext): Promise<ScheduleOutput> =>
      buildSchedule(config, input, scheduleCaller(config.demo ? DEMO_MEMBERS : config.members, context), now(), deps.runGog),
  };
}
