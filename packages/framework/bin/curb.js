#!/usr/bin/env node
// The framework ships TypeScript source (no build step yet); tsx compiles it
// on the fly. tsx applies its tsconfig only to files the config includes, so
// this shim points TSX_TSCONFIG_PATH at a generated config spanning both the
// framework source and the project's src/ — otherwise JSX in either tree
// would fall back to the classic transform and crash with "React is not
// defined". When the package grows a dist build, the shim switches to
// importing the compiled CLI and the generated config only needs the
// project's files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnUnsupportedNode } from "./node-version.js";

exitOnUnsupportedNode(new URL("../package.json", import.meta.url));

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
          toPosix(join(relative(generatedDir, packageRoot), "src/**/*")),
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
await import("../src/cli/main.ts");
