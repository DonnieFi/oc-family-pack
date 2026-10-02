import { register } from "node:module";

register(new URL("./css-test-hook.mjs", import.meta.url), import.meta.url);
