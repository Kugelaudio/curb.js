// create-curb.js runs npm install so that a network that only allows the npm registry still
// installs: onnxruntime-node's postinstall downloads extra binaries from another host, which
// the agent does not need. A failed install names the one-line fix.
import assert from "node:assert/strict";
import test from "node:test";
import { installEnv, installFailureHint } from "../bin/install-env.js";

test("the install skips onnxruntime-node's binary downloads", () => {
  const env = installEnv({ PATH: "/bin" });
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL, "skip");
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL_CUDA, "skip");
  assert.equal(env.PATH, "/bin");
});

test("a value the user already set is kept", () => {
  const env = installEnv({ ONNXRUNTIME_NODE_INSTALL_CUDA: "1" });
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL_CUDA, "1");
  assert.equal(env.ONNXRUNTIME_NODE_INSTALL, "skip");
});

test("the failure hint names the one-line fix", () => {
  const hint = installFailureHint("my-agent");
  assert.match(hint, /ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install/);
  assert.match(hint, /my-agent/);
});
