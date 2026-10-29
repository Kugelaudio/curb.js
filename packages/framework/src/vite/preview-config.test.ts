import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, isFileLoadingAllowed, resolveConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewConfig, scanAliasPlugin } from "./preview-config.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A framework installed the way a project installs it: its source under node_modules, its
 * page (in src/preview, as the real one) reaching a dependency only through one of its own
 * `@/` imports into another directory of src. */
function installedFramework(): { root: string; src: string; cacheDir: string } {
  const project = mkdtempSync(join(tmpdir(), "curb-scan-"));
  made.push(project);
  const root = join(project, "node_modules", "framework");
  const src = join(root, "src");
  mkdirSync(join(src, "ui"), { recursive: true });
  mkdirSync(join(src, "preview"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<script type="module" src="/src/preview/main.tsx"></script>\n');
  writeFileSync(join(src, "index.ts"), "export {};\n");
  writeFileSync(join(src, "preview", "main.tsx"), 'import { Button } from "@/ui/button.js";\nconsole.log(Button);\n');
  writeFileSync(join(src, "ui", "button.tsx"), 'import { widget } from "widget-lib";\nexport const Button = widget;\n');
  const dependency = join(project, "node_modules", "widget-lib");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "widget-lib", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(dependency, "index.js"), "export const widget = 1;\n");
  return { root, src, cacheDir: join(project, ".curb", "vite") };
}

/** What Vite's dependency scan finds when the server starts. */
async function scannedDependencies(withPlugin: boolean): Promise<string[]> {
  const { root, src, cacheDir } = installedFramework();
  const server = await createServer({
    configFile: false,
    root,
    cacheDir,
    logLevel: "silent",
    resolve: { alias: { "@": src } },
    optimizeDeps: withPlugin ? { esbuildOptions: { plugins: [scanAliasPlugin(src)] } } : {},
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const optimizer = server.environments.client.depsOptimizer;
    await optimizer?.scanProcessing;
    return Object.keys({ ...optimizer?.metadata.optimized, ...optimizer?.metadata.discovered });
  } finally {
    await server.close();
  }
}

describe("the preview's dependency scan", () => {
  it("stops at the first `@/` import of an installed framework without the scan alias", async () => {
    expect(await scannedDependencies(false)).not.toContain("widget-lib");
  });

  it("follows `@/` imports into the framework source, so their dependencies are pre-bundled", async () => {
    const found = await scannedDependencies(true);
    expect(found).toContain("widget-lib");
    expect(found.filter((id) => id.startsWith("@/"))).toEqual([]);
  });
});

describe("the preview's file serving", () => {
  it("serves the project's dependencies where its node_modules really is", async () => {
    // A hosted workspace starts on the image's read-only install: node_modules is a link
    // out of the project, and the framework's font comes from there.
    const project = mkdtempSync(join(tmpdir(), "curb-project-"));
    const install = mkdtempSync(join(tmpdir(), "curb-install-"));
    made.push(project, install);
    const font = join(install, "node_modules", "@fontsource-variable", "inter", "files", "inter.woff2");
    mkdirSync(dirname(font), { recursive: true });
    writeFileSync(font, "");
    symlinkSync(join(install, "node_modules"), join(project, "node_modules"));
    const config = await resolveConfig(createPreviewConfig({ projectRoot: project, attachTo: createHttpServer() }), "serve");
    expect(isFileLoadingAllowed(config, realpathSync(font))).toBe(true);
  });
});
