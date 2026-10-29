import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The curb package version, read from package.json (single source of truth). */
export function curbVersion(): string {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}
