import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ConfigSchema, parseConfig } from "./config.ts";
import { CALENDAR_WRITE_ACTION, contract, WEEK_METHOD } from "./contract.ts";
import { execGog } from "./calendar-gog.ts";
import { watchCalendars } from "./calendar-watch.ts";
import { registerFamilyCli } from "./gog-setup.ts";
import { familyHandlers, familyWeek } from "./handlers.ts";
import { openFamilyStore, type FamilyStore } from "./store.ts";
import { weekMethod } from "./week-method.ts";
import { familyGrant } from "./grant.ts";
import { CALENDAR_DELETE_TOOL, CALENDAR_MOVE_TOOL, CALENDAR_UPDATE_TOOL, CalendarDeleteInputSchema, CalendarMoveInputSchema, CalendarUpdateInputSchema } from "./calendar-change.ts";
import { CALENDAR_CREATE_TOOL, CalendarCreateInputSchema } from "./calendar-create.ts";
import { registerCalendarWrite, type CalendarWriteApi } from "./calendar-tools.ts";
import { pageWrite } from "./page-write.ts";
import { briefDirectory, startBriefs } from "./briefs.ts";
import { deliver } from "./discord-delivery.ts";
import { createGarbageFeed } from "./garbage.ts";
import { readEcWeather } from "./weather-ec.ts";

function configuredGogPath(raw: unknown): string {
  try {
    return parseConfig(raw).gogPath;
  } catch {
    return "gog";
  }
}

const plugin = defineFeaturePlugin({
  contract,
  name: "Family",
  description: "A calm family week view in the Control UI: shared calendars, local weather, and quick chats with your agents.",
  // Queries are operator.read; defineFeaturePlugin sets that scope on every query.
  // Family commands are not registered here. The contract commands adapter always
  // sets requiredScopes, which the shipped command gate then limits to the owner.
  setup(api, events) {
    api.registerCli(({ program, config }) => {
      registerFamilyCli(program, { run: execGog(), gogPath: configuredGogPath(api.pluginConfig), gateway: config.gateway, host: config });
    }, {
      commands: ["family"],
      descriptors: [{ name: "family", description: "Family Pack setup", hasSubcommands: true }],
    });
    // Discovery loads the plugin without starting it. The worker belongs to the
    // service start, which the host only calls in a live Gateway.
    let store: FamilyStore | undefined;
    if (api.registrationMode === "full") {
      api.registerService({
        id: "family-store",
        reload: { configPrefixes: ["plugins.entries.oc-family-pack.config"] },
        async start(ctx) {
          const opened = await openFamilyStore({
            stateDir: ctx.stateDir,
            logger: ctx.logger,
            reportFailure: (error) => ctx.serviceHealth?.reportFailure(error),
          });
          store = opened;
          ctx.logger.info(
            `oc-family-pack store ready (node ${opened.ready.nodeVersion}, sqlite ${opened.ready.sqliteVersion}, journal ${opened.ready.journalMode})`,
          );
        },
        async stop() {
          const current = store;
          store = undefined;
          await current?.stop();
        },
      });
    }
    const config = parseConfig(api.pluginConfig);
    if (api.registrationMode === "full") {
      // Polls Google for edits made outside the page; like the store, it runs only in a live Gateway.
      let stopWatch: (() => void) | undefined;
      api.registerService({
        id: "calendar-watch",
        reload: { configPrefixes: ["plugins.entries.oc-family-pack.config"] },
        start(ctx) {
          stopWatch = watchCalendars({ config, runGog: execGog(), events, logger: ctx.logger, grant: familyGrant });
        },
        stop() {
          stopWatch?.();
          stopWatch = undefined;
        },
      });
    }
    const summaryChannel = config.summaryChannel;
    if (api.registrationMode === "full" && summaryChannel !== undefined) {
      // The daily and weekly briefs: a minute poll in the live Gateway, posted through the host's durable outbound.
      let stopBriefs: (() => void) | undefined;
      api.registerService({
        id: "family-briefs",
        reload: { configPrefixes: ["plugins.entries.oc-family-pack.config"] },
        async start(ctx) {
          const { sendDurableMessageBatch } = await import("openclaw/plugin-sdk/channel-outbound");
          const { resolveAgentIdentity, resolveDefaultAgentId } = await import("openclaw/plugin-sdk/agent-runtime");
          const garbage = createGarbageFeed(fetch, { log: (line) => ctx.logger.warn(line) });
          const directory = briefDirectory(config);
          stopBriefs = startBriefs({
            config,
            store: () => store,
            deliver: (target, messages, key) => deliver(sendDurableMessageBatch, ctx.config, directory, target, messages, key),
            agentName: async () => {
              const id = resolveDefaultAgentId(ctx.config);
              return resolveAgentIdentity(ctx.config, id)?.name?.trim() || id;
            },
            readWeather: async () => {
              const state = await readEcWeather(config.location, undefined, Date.now(), { timezone: config.timezone });
              return state.status === "ok" ? state.data : undefined;
            },
            garbageTomorrow: async (now) => (config.garbageIcsUrl === undefined ? undefined : garbage.tomorrow(config.garbageIcsUrl, config.timezone, now)),
            log: (line) => ctx.logger.warn(line),
          });
        },
        stop() {
          stopBriefs?.();
          stopBriefs = undefined;
        },
      });
    }
    // The four calendar write tools and their before_tool_call approval hook, registered together.
    const writeApi: CalendarWriteApi = {
      on: (hookName, handler, opts) => api.on(hookName, handler, opts),
      registerTool: (factory, opts) => api.registerTool(factory, opts),
    };
    registerCalendarWrite(writeApi, { config, runGog: execGog(), grant: familyGrant, log: () => store });
    // The week is a Gateway method, not a feature query, because only a Gateway
    // method sees who signed in. Same operator.read scope the queries get.
    api.registerGatewayMethod(WEEK_METHOD, weekMethod(familyWeek(config, { grant: familyGrant })), { scope: "operator.read" });
    return {
      ...familyHandlers(config, { log: (line) => api.logger.warn(line) }),
      [CALENDAR_WRITE_ACTION]: pageWrite({
        config,
        runGog: execGog(),
        grant: familyGrant,
        log: () => store,
        changed: (calendarKeys) => {
          try {
            events.emit("calendar-changed", { reason: "write", calendarKeys, at: new Date().toISOString() });
          } catch {
            // The write stands; open pages catch up on the next poll.
          }
        },
      }),
    };
  },
});

// defineFeaturePlugin (openclaw 2026.9.7) takes no configSchema option, and the
// plugin it returns exposes configSchema as a getter with no setter, so assigning
// it throws in this module. The tool metadata is what `openclaw plugins build`
// writes into the manifest, so the real schema goes there. Tracked upstream in
// s5k.31.2; delete this once the SDK accepts configSchema.
const metadata = getToolPluginMetadata(plugin);
if (!metadata) {
  throw new Error("oc-family-pack: feature plugin metadata is missing");
}
metadata.configSchema = { ...ConfigSchema };
// The calendar write tools are registered with api.registerTool, not through the feature
// contract, so they get no page session action. `openclaw plugins build` reads contracts.tools
// from this list.
metadata.tools.push(
  {
    name: CALENDAR_CREATE_TOOL,
    label: "Add to calendar",
    description: "Add one event to a family calendar; some additions wait for a parent to approve them.",
    parameters: { ...CalendarCreateInputSchema },
  },
  {
    name: CALENDAR_UPDATE_TOOL,
    label: "Change a calendar event",
    description: "Change one family calendar event; some changes wait for a parent to approve them.",
    parameters: { ...CalendarUpdateInputSchema },
  },
  {
    name: CALENDAR_MOVE_TOOL,
    label: "Move a calendar event",
    description: "Move one event to another family calendar; some moves wait for a parent to approve them.",
    parameters: { ...CalendarMoveInputSchema },
  },
  {
    name: CALENDAR_DELETE_TOOL,
    label: "Delete a calendar event",
    description: "Delete one family calendar event; some deletions wait for a parent to approve them.",
    parameters: { ...CalendarDeleteInputSchema },
  },
);

export default plugin;
