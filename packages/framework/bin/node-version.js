// Refuses a Node.js older than this package's `engines.node`, by name, before
// anything version-sensitive loads. `engines` alone only makes npm warn, and an
// old Node then fails much later with an unrelated syntax or API error.
// `packages/create-framework-app/bin/node-version.js` is the same check for
// the scaffolder, which ships as its own package.
import { readFileSync } from "node:fs";

/** The `engines.node` floor as `[major, minor, patch]`. Only `>=X.Y.Z` is accepted, so the
 * range stays one number that this check and npm read the same way. */
export function nodeFloor(range) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`package.json "engines.node" must read ">=X.Y.Z", got ${JSON.stringify(range)}`);
  }
  return match.slice(1).map(Number);
}

/** The refusal for `version` (as in `process.versions.node`), or null when it is supported. */
export function unsupportedNodeMessage(packageName, range, version) {
  const floor = nodeFloor(range);
  const running = version.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (running[index] > floor[index]) return null;
    if (running[index] < floor[index]) {
      return (
        `UnsupportedNodeVersion: ${packageName} needs Node.js ${range}, ` +
        `but this is Node.js ${version}. Install Node.js ${floor.join(".")} or newer ` +
        "(https://nodejs.org) and run the command again."
      );
    }
  }
  return null;
}

/** Exits 1 with the refusal when the running Node is older than `engines.node` in the
 * package.json at `packageJsonUrl`. */
export function exitOnUnsupportedNode(packageJsonUrl) {
  const manifest = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  const message = unsupportedNodeMessage(
    manifest.name,
    manifest.engines && manifest.engines.node,
    process.versions.node,
  );
  if (message) {
    console.error(message);
    process.exit(1);
  }
}
