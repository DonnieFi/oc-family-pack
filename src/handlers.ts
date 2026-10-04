import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { RunGog } from "./calendar-gog.ts";
import type { GrantHolder } from "./grant.ts";
import { DEMO_MEMBERS } from "./demo.ts";
import { createGarbageFeed, garbageSchedule, type GarbageFetch } from "./garbage.ts";
import { buildWeekPayload } from "./payload.ts";
import { buildSchedule, scheduleCaller } from "./schedule.ts";
import { buildToday } from "./today.ts";
import type { Config, GarbageOutput, MembersPayload, ScheduleInput, ScheduleOutput, TodayPayload, WeatherState, WeekPayload } from "./types.ts";
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
  /** The garbage calendar fetch. Defaults to the global fetch. */
  fetchGarbage?: GarbageFetch;
  /** Where a failed garbage-calendar read is reported (never with the URL). */
  log?: (line: string) => void;
};

/** The Environment Canada card for the configured location, in the household's zone, cached for 30 minutes. */
function weatherReader(config: Config, deps: FamilyHandlerDeps, now: () => number) {
  return () => readEcWeather(config.location, deps.fetchWeather, now(), { timezone: config.timezone });
}

/** The week `viewer` may see, for the `family.week` Gateway method. */
export function familyWeek(config: Config, deps: FamilyHandlerDeps = {}) {
  const now = deps.now ?? Date.now;
  const readWeather = weatherReader(config, deps, now);
  return ({ start }: { start?: string }, viewer: Viewer, canEdit = false): Promise<WeekPayload> =>
    buildWeekPayload(config, start, now(), readWeather, viewer, {
      canEdit,
      grantReadOnly: deps.grant?.get() === "read-only",
    });
}

/** Handlers for the registered queries. `family.schedule`, `family.today`, and `family.garbage` are also the agent's tools. */
export function familyHandlers(config: Config, deps: FamilyHandlerDeps = {}) {
  const now = deps.now ?? Date.now;
  const garbage = createGarbageFeed(deps.fetchGarbage, deps.log ? { log: deps.log } : {});
  const readWeather = weatherReader(config, deps, now);
  const caller = (context: FeatureInvocationContext) => scheduleCaller(config.demo ? DEMO_MEMBERS : config.members, context);
  return {
    "family.members": (): MembersPayload => ({
      members: resolveMembers(config.demo ? DEMO_MEMBERS : config.members),
    }),
    "family.weather": (): Promise<WeatherState> => readWeather(),
    "family.schedule": (input: ScheduleInput, context: FeatureInvocationContext): Promise<ScheduleOutput> =>
      buildSchedule(config, input, caller(context), now(), deps.runGog),
    "family.today": (_input: object, context: FeatureInvocationContext): Promise<TodayPayload> =>
      buildToday(config, caller(context), now(), { ...(deps.runGog === undefined ? {} : { runGog: deps.runGog }), garbage }),
    "family.garbage": (): Promise<GarbageOutput> => garbageSchedule(garbage, config, now()),
  };
}
