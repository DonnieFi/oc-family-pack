import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ConfigSchema, parseConfig } from "./config.js";
import { contract } from "./contract.js";
import { execGog } from "./calendar-gog.js";
import { registerFamilyCli } from "./gog-setup.js";
import { familyHandlers } from "./handlers.js";
import { openFamilyStore } from "./store.js";
function configuredGogPath(raw) {
    try {
        return parseConfig(raw).gogPath;
    }
    catch {
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
    setup(api) {
        api.registerCli(({ program }) => {
            registerFamilyCli(program, { run: execGog(), gogPath: configuredGogPath(api.pluginConfig) });
        }, {
            commands: ["family"],
            descriptors: [{ name: "family", description: "Family Pack setup", hasSubcommands: true }],
        });
        // Discovery loads the plugin without starting it. The worker belongs to the
        // service start, which the host only calls in a live Gateway.
        if (api.registrationMode === "full") {
            let store;
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
                    ctx.logger.info(`oc-family-pack store ready (node ${opened.ready.nodeVersion}, sqlite ${opened.ready.sqliteVersion}, journal ${opened.ready.journalMode})`);
                },
                async stop() {
                    const current = store;
                    store = undefined;
                    await current?.stop();
                },
            });
        }
        return familyHandlers(parseConfig(api.pluginConfig));
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
export default plugin;
