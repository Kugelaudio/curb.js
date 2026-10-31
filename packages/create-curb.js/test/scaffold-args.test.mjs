import assert from "node:assert/strict";
import test from "node:test";
import { scaffoldArgs } from "../bin/scaffold-args.js";

test("creates my-agent when no folder is named, and passes everything else through", () => {
  assert.deepEqual(scaffoldArgs([]), ["my-agent"]);
  assert.deepEqual(scaffoldArgs(["--llm", "anthropic"]).slice(0, 1), ["my-agent"]);
  assert.deepEqual(scaffoldArgs(["support-bot"]), ["support-bot"]);
  assert.deepEqual(scaffoldArgs(["."]), ["."]);
  assert.deepEqual(scaffoldArgs(["--help"]), ["--help"]);
});
