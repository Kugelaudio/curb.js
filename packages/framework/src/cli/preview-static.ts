import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { staticFile } from "../browser/static-serving.js";
import { resolveContextDir } from "../project.node.js";
import { listContextMarkdownFiles } from "../vite/context-index-plugin.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/**
 * The preview page as `curb dev` serves it when the framework is installed from npm: built
 * once into `dist/preview/` (`scripts/build-dist.ts`), so starting it compiles nothing. What a
 * checkout's Vite server adds on top is the same here: the project's `context/` markdown at
 * the root, `/context.index.json` listing it, and the page itself for every path with no file
 * (the preview routes skills by path).
 */
export function builtPreview(options: { previewDir: string; projectRoot: string }): (req: IncomingMessage, res: ServerResponse) => void {
  const { previewDir, projectRoot } = options;
  if (!existsSync(join(previewDir, "index.html"))) {
    throw new Error(`curb dev: the built preview is missing at ${previewDir}. Reinstall curb (npm install).`);
  }
  const contextDir = resolveContextDir(projectRoot);
  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      return void res.end();
    }
    if (pathname === "/context.index.json") {
      const files = existsSync(contextDir) ? listContextMarkdownFiles(contextDir) : [];
      res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
      return void res.end(JSON.stringify(files));
    }
    for (const root of [previewDir, contextDir]) {
      const file = staticFile(root, pathname);
      if (file !== null && statSync(file, { throwIfNoEntry: false })?.isFile()) {
        // Vite names every built asset by its hash, so only those may be kept.
        const immutable = root === previewDir && pathname.startsWith("/assets/");
        return send(res, file, immutable ? "public, max-age=31536000, immutable" : "no-store", req.method === "HEAD");
      }
    }
    if (!extname(pathname)) return send(res, join(previewDir, "index.html"), "no-store", req.method === "HEAD");
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };
}

function send(res: ServerResponse, file: string, cacheControl: string, headOnly: boolean): void {
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": body.byteLength,
    "cache-control": cacheControl,
  });
  res.end(headOnly ? undefined : body);
}
