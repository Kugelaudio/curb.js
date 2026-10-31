import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Tests run against the bundled fixture project (a copy of the insurance
 * example) so the package suite stays hermetic: the same AGENT_PROJECT_DIR
 * discovery path as a real consuming project, without reaching outside the
 * package. */
const fixtureProject = resolve(import.meta.dirname, "src/test-fixtures/project");

/** The suite's areas. `npm test` runs them all; `npx vitest run --project cli` runs one.
 * `core` takes whatever no area names, so a new test can never fall out of the suite. */
const TESTS = "**/*.test.{ts,tsx}";
const areas: Record<string, string[]> = {
  api: ["src/public-api.test.ts"],
  cli: [`src/cli/${TESTS}`],
  build: [`src/bundler/${TESTS}`],
  server: [`src/server/${TESTS}`],
  protocol: [`src/hosted/${TESTS}`, `src/client/${TESTS}`],
  preview: [`src/preview/${TESTS}`, `src/vite/${TESTS}`, `src/browser/${TESTS}`],
};

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
    exclude: ["dist/**", "node_modules/**"],
    env: {
      AGENT_PROJECT_DIR: fixtureProject,
    },
    projects: [
      ...Object.entries(areas).map(([name, include]) => ({ extends: true, test: { name, include } })),
      { extends: true, test: { name: "core", include: [`src/${TESTS}`], exclude: Object.values(areas).flat() } },
    ],
  },
});
