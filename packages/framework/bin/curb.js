#!/usr/bin/env node
// Installed from npm, the framework is compiled JavaScript in dist/ (scripts/build-dist.ts) and
// this shim runs dist/cli.js. In a checkout it is TypeScript in src/, which tsx compiles on the
// fly. Either way a project's own agent is TypeScript, so tsx is registered for it.
//
// tsx applies its tsconfig only to files the config includes, so this shim points
// TSX_TSCONFIG_PATH at a generated config spanning the project's src/ and, in a checkout, the
// framework source: otherwise JSX outside the config would fall back to the classic transform
// and crash with "React is not defined".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnUnsupportedNode } from "./node-version.js";

exitOnUnsupportedNode(new URL("../package.json", import.meta.url));

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// npm receives dist/ and no src/ (`files` in package.json); a checkout has src/.
const fromSource = existsSync(join(packageRoot, "src", "cli", "main.ts"));

if (!process.env.TSX_TSCONFIG_PATH) {
  const projectRoot = process.cwd();
  if (existsSync(join(projectRoot, "src", "agent"))) {
    const generatedDir = join(projectRoot, ".curb");
    const generatedPath = join(generatedDir, "tsx.tsconfig.json");
    const toPosix = (path) => path.split("\\").join("/");
    const config = `${JSON.stringify(
      {
        compilerOptions: { jsx: "react-jsx" },
        include: [
          ...(fromSource ? [toPosix(join(relative(generatedDir, packageRoot), "src/**/*"))] : []),
          "../src/**/*",
        ],
      },
      null,
      2,
    )}\n`;
    mkdirSync(generatedDir, { recursive: true });
    if (!existsSync(generatedPath) || readFileSync(generatedPath, "utf8") !== config) {
      writeFileSync(generatedPath, config);
    }
    process.env.TSX_TSCONFIG_PATH = generatedPath;
  } else {
    // Not a project directory — still cover the CLI's own source so it can
    // print its agent-readable "no project here" error. This file ships in bin/:
    // the package's tsconfig.json is not published.
    process.env.TSX_TSCONFIG_PATH = join(packageRoot, "bin", "tsx.tsconfig.json");
  }
}

// Dynamic imports so TSX_TSCONFIG_PATH is set before tsx reads it.
const { register } = await import("tsx/esm/api");
register();
await import(fromSource ? "../src/cli/main.ts" : "../dist/cli.js");
