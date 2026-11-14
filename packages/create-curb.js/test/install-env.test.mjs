// create-curb.js runs npm install so that a network that only allows the npm registry still
// installs: onnxruntime-node's postinstall downloads extra binaries from another host, which
// the agent does not need. A failed install names the one-line fix for each shell.
import assert from "node:assert/strict";
import test from "node:test";
import { INSTALL_PREFERENCE_KEYS, installEnv, installFailureHint } from "../bin/install-env.js";

const none = () => undefined;

test("the install skips onnxruntime-node's binary downloads when the user chose nothing", () => {
  const env = installEnv({ PATH: "/bin" }, none);
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL, "skip");
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL_CUDA, "skip");
  assert.equal(env.PATH, "/bin");
});

test("empty values count as unset, as the postinstall treats them", () => {
  const env = installEnv({ ONNXRUNTIME_NODE_INSTALL: "", npm_config_onnxruntime_node_install_cuda: "" }, none);
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL, "skip");
});

for (const key of [
  "ONNXRUNTIME_NODE_INSTALL",
  "ONNXRUNTIME_NODE_INSTALL_CUDA",
  "npm_config_onnxruntime_node_install",
  "npm_config_onnxruntime_node_install_cuda",
  "NPM_CONFIG_ONNXRUNTIME_NODE_INSTALL",
]) {
  test(`${key} set by the user leaves the environment untouched`, () => {
    const base = { [key]: "1" };
    assert.deepEqual(installEnv(base, none), base);
  });
}

test("a preference in .npmrc or the npm user config leaves the environment untouched", () => {
  const asked = [];
  const npmConfig = (key) => {
    asked.push(key);
    return key === "onnxruntime-node-install-cuda" ? "v12" : undefined;
  };
  assert.deepEqual(installEnv({ PATH: "/bin" }, npmConfig), { PATH: "/bin" });
  assert.deepEqual(asked.sort(), ["onnxruntime-node-install", "onnxruntime-node-install-cuda"]);
});

test("the preference keys are the ones the postinstall reads", () => {
  assert.deepEqual(INSTALL_PREFERENCE_KEYS, ["onnxruntime-node-install", "onnxruntime-node-install-cuda"]);
});

test("the Windows hint shows Command Prompt and PowerShell", () => {
  const hint = installFailureHint("my-agent", "win32");
  assert.match(hint, /my-agent/);
  assert.match(hint, /set ONNXRUNTIME_NODE_INSTALL=skip&& set ONNXRUNTIME_NODE_INSTALL_CUDA=skip&& npm install/);
  assert.match(hint, /\$env:ONNXRUNTIME_NODE_INSTALL='skip'; \$env:ONNXRUNTIME_NODE_INSTALL_CUDA='skip'; npm install/);
  assert.doesNotMatch(hint, /^ONNXRUNTIME/m);
});

test("the POSIX hint is one assignment line", () => {
  const hint = installFailureHint("my-agent", "linux");
  assert.match(hint, /ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install/);
  assert.doesNotMatch(hint, /\$env:|set ONNX/);
});
