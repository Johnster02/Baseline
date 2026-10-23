import { defineConfig } from "vitest/config";
// css: true so `style.css?raw` imports return the real file in tests.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    css: true,
    setupFiles: ["test/setup.ts"],
    exclude: ["node_modules/**", "mod-tests/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Process entry points only run as built bundles in child processes (see entry.spec,
      // hook-entry.spec, runner-script.spec), where v8 coverage can't see them.
      exclude: ["src/report/raw.d.ts", "src/entry.ts", "src/hooks/entry.ts", "src/browser/client.ts"],
      reporter: ["text-summary", "html"],
      // Floors for the safety-critical areas; raise them as coverage grows.
      thresholds: {
        "src/browser/**": { lines: 75, branches: 65 },
        "src/hooks/**": { lines: 85, branches: 75 },
        "src/run/**": { lines: 75, branches: 65 },
      },
    },
  },
});
