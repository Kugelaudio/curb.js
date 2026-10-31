import assert from "node:assert/strict";
import test from "node:test";
import { npmCommand } from "../bin/npm-command.js";

test("starts npx directly outside Windows", () => {
  assert.deepEqual(npmCommand("npx", ["--yes", "my agent"], "linux"), {
    file: "npx",
    args: ["--yes", "my agent"],
    shell: false,
  });
});

test("starts npx through the shell on Windows, where it is a .cmd shim, with each argument quoted", () => {
  assert.deepEqual(npmCommand("npx", ["--yes", "my agent", "a&b"], "win32"), {
    file: 'npx "--yes" "my agent" "a&b"',
    args: [],
    shell: true,
  });
});

test("refuses an argument a Windows shell could not read as one", () => {
  assert.throws(() => npmCommand("npx", ['a" & calc & "'], "win32"), /quote/);
});
