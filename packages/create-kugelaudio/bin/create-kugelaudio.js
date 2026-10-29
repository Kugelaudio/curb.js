#!/usr/bin/env node
// `npm create kugelaudio my-agent`: runs the newest create-curb-app from KugelAudio's CDN.
// This package only points there, so it needs no new release when Curb has one.
import { spawnSync } from "node:child_process";
import { newestCreateApp, scaffoldArgs } from "./newest.js";

const cdn = (process.env.CURB_CDN ?? "https://cdn.kugelaudio.com/curb").replace(/\/$/, "");
let release;
try {
  release = await newestCreateApp(cdn);
} catch (error) {
  console.error(`Could not reach KugelAudio (${error.message}). Check your connection and run it again.`);
  process.exit(1);
}
const run = spawnSync(
  "npx",
  ["--yes", "--loglevel=error", "--allow-remote=all", release.url, ...scaffoldArgs(process.argv.slice(2))],
  // The newest release is already running, so create-curb-app does not look for a newer one.
  { stdio: "inherit", env: { ...process.env, CREATE_CURB_APP_HANDOFF: release.version } },
);
if (run.error) {
  console.error(`Could not start npx (${run.error.message}).`);
  process.exit(1);
}
process.exit(run.status ?? 1);
