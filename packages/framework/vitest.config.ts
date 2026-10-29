import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Tests run against the bundled fixture project (a copy of the insurance
 * example) so the package suite stays hermetic: the same AGENT_PROJECT_DIR
 * discovery path as a real consuming project, without reaching outside the
 * package. */
const fixtureProject = resolve(import.meta.dirname, "src/test-fixtures/project");

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Same "@" → src alias as the preview config, so tests can import modules
    // that reach preview UI code (e.g. the block preview registry).
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    env: {
      AGENT_PROJECT_DIR: fixtureProject,
    },
  },
});
