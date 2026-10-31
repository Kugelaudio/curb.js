import assert from "node:assert/strict";
import test from "node:test";
import { npmCommand } from "../bin/npm-command.js";

test("starts npm directly outside Windows", () => {
  assert.deepEqual(npmCommand("npm", ["--yes", "my agent"], "linux"), {
    file: "npm",
    args: ["--yes", "my agent"],
    shell: false,
  });
});

test("starts npm through the shell on Windows, where it is a .cmd shim, with each argument quoted", () => {
  assert.deepEqual(npmCommand("npm", ["--yes", "my agent", "a&b"], "win32"), {
    file: 'npm "--yes" "my agent" "a&b"',
    args: [],
    shell: true,
  });
});

test("refuses an argument a Windows shell could not read as one", () => {
  assert.throws(() => npmCommand("npm", ['a" & calc & "'], "win32"), /quote/);
});
