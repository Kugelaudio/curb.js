import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./layout.js";

/** The curb package version, read from package.json (single source of truth). */
export function curbVersion(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}
