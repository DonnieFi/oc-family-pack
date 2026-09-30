import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ConfigSchema, parseConfig } from "./config.js";
import { contract } from "./contract.js";
import { buildWeekPayload } from "./payload.js";
import { readEcWeather } from "./weather-ec.js";
const plugin = defineFeaturePlugin({
    contract,
    name: "Family",
    description: "A calm family week view in the Control UI: shared calendars, local weather, and quick chats with your agents.",
    setup(api) {
        const config = parseConfig(api.pluginConfig);
        return {
            "family.week": ({ start }) => buildWeekPayload(config, start, Date.now(), () => readEcWeather(config.location)),
        };
    },
});
// defineFeaturePlugin (openclaw 2026.9.7) has no configSchema option and publishes a strict
// empty schema, which `openclaw plugins build` writes into the manifest the host validates
// config against. Delete this once the SDK accepts configSchema.
const metadata = getToolPluginMetadata(plugin);
if (!metadata) {
    throw new Error("oc-family-pack: feature plugin metadata is missing");
}
metadata.configSchema = { ...ConfigSchema };
export default plugin;
