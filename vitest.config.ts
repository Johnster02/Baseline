import { defineConfig } from "vitest/config";
// css: true so `style.css?raw` imports return the real file in tests.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 30000, css: true, exclude: ["node_modules/**", "mod-tests/**"] } });
