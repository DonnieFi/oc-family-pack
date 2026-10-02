import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ConfigSchema, parseConfig } from "./config.ts";
import { contract } from "./contract.ts";
import { familyHandlers } from "./handlers.ts";

const plugin = defineFeaturePlugin({
  contract,
  name: "Family",
  description: "A calm family week view in the Control UI: shared calendars, local weather, and quick chats with your agents.",
  // Queries are operator.read; defineFeaturePlugin sets that scope on every query.
  // Family commands are not registered here. The contract commands adapter always
  // sets requiredScopes, which the shipped command gate then limits to the owner.
  setup(api) {
    return familyHandlers(parseConfig(api.pluginConfig));
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
