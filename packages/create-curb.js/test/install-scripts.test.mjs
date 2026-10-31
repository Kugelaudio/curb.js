// create-curb.js fails the setup when npm 12 skipped a dependency's install script, and
// names the two commands that fix it, instead of reporting success for a project whose
// first turn would fail.
import assert from "node:assert/strict";
import test from "node:test";
import { installScriptsFix, pendingInstallScripts } from "../bin/install-scripts.js";

// In the shape `npm install-scripts ls --json` prints on npm 12.0.1 for a scaffold without allowScripts.
const BLOCKED = JSON.stringify({
  allowScripts: [
    {
      name: "onnxruntime-node",
      changes: [
        { key: "onnxruntime-node@1.24.3", change: "pending" },
        { key: "onnxruntime-node@1.30.0", change: "pending" },
      ],
    },
    { name: "protobufjs", changes: [{ key: "protobufjs@7.5.4", change: "pending" }] },
  ],
});

test("every package npm reports as pending is blocked, once, in npm's order", () => {
  assert.deepEqual(pendingInstallScripts(BLOCKED), ["onnxruntime-node", "protobufjs"]);
});

test("nothing is blocked when allowScripts decides every install script", () => {
  assert.deepEqual(pendingInstallScripts('{\n  "allowScripts": []\n}\n'), []);
});

test("output without an allowScripts list fails loudly instead of reading as nothing blocked", () => {
  assert.throws(() => pendingInstallScripts("{}"), /printed no "allowScripts" list/);
  assert.throws(() => pendingInstallScripts("npm error Unknown command"), SyntaxError);
});

test("the fix approves the blocked scripts, then runs them", () => {
  assert.deepEqual(installScriptsFix(["protobufjs", "sharp"]), [
    "npm install-scripts approve protobufjs sharp",
    "npm rebuild protobufjs sharp",
  ]);
});
