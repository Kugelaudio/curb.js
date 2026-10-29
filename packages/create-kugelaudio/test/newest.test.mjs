import assert from "node:assert/strict";
import test from "node:test";
import { newestCreateApp, scaffoldArgs } from "../bin/newest.js";

const answering = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });

test("runs the create-curb-app release latest.json names, from the same CDN", async () => {
  const latest = { version: "1.10.1", createApp: { version: "1.10.1", tarball: "create-curb-app-1.10.1.tgz" } };
  assert.deepEqual(await newestCreateApp("https://cdn.example/curb", { fetchImpl: answering(200, latest) }), {
    version: "1.10.1",
    url: "https://cdn.example/curb/create-curb-app-1.10.1.tgz",
  });
});

test("says why when the pointer cannot be read or names no release", async () => {
  await assert.rejects(newestCreateApp("https://cdn.example/curb", { fetchImpl: answering(503, {}) }), /HTTP 503/);
  await assert.rejects(newestCreateApp("https://cdn.example/curb", { fetchImpl: answering(200, { version: "1" }) }), /names no release/);
});

test("creates my-agent when no folder is named, and passes everything else through", () => {
  assert.deepEqual(scaffoldArgs([]), ["my-agent"]);
  assert.deepEqual(scaffoldArgs(["--llm", "anthropic"]).slice(0, 1), ["my-agent"]);
  assert.deepEqual(scaffoldArgs(["support-bot"]), ["support-bot"]);
  assert.deepEqual(scaffoldArgs(["."]), ["."]);
  assert.deepEqual(scaffoldArgs(["--help"]), ["--help"]);
});
