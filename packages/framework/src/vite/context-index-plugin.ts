import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite";
import { resolveContextDir } from "../project.node.js";

function listContextMarkdownFiles(contextDir: string): string[] {
  const results: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.endsWith(".md")) {
        results.push(relative(contextDir, fullPath));
      }
    }
  }

  walk(contextDir);
  return results.sort();
}

/**
 * Keeps `context/context.index.json` in sync with the project's markdown so
 * the browser preview can preload file-backed `<Text file=…>` content. A
 * project without a `context/` directory simply has no index (the preview
 * treats the missing index as "no files").
 */
export function contextIndexPlugin(projectRoot: string): Plugin {
  const contextDir = resolveContextDir(projectRoot);

  function writeContextIndex(): void {
    if (!existsSync(contextDir)) return;
    writeFileSync(
      join(contextDir, "context.index.json"),
      `${JSON.stringify(listContextMarkdownFiles(contextDir), null, 2)}\n`,
    );
  }

  return {
    name: "framework:context-index",
    buildStart() {
      writeContextIndex();
    },
    configureServer(server) {
      writeContextIndex();
      // Answer the index route directly: with no context/ directory there is
      // no file to serve, and Vite's SPA fallback would return index.html
      // (HTTP 200) — which the preview would try to parse as JSON.
      server.middlewares.use("/context.index.json", (_req, res) => {
        const files = existsSync(contextDir) ? listContextMarkdownFiles(contextDir) : [];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(files));
      });
      server.watcher.on("all", (_event, file) => {
        if (file.startsWith(contextDir) && file.endsWith(".md")) {
          writeContextIndex();
        }
      });
    },
  };
}
