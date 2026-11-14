// onnxruntime-node's postinstall downloads extra binaries (GPU builds) from a host other than
// the npm registry. The agent does not need them, and on a network that allows only the
// registry the download fails and takes the whole npm install down with it. npm 10 runs the
// script even when package.json's allowScripts denies it, so the install skips the download
// through the package's own switches.

/** The environment for `npm install`: the downloads are skipped unless the user chose otherwise. */
export function installEnv(base = process.env) {
  return { ONNXRUNTIME_NODE_INSTALL: "skip", ONNXRUNTIME_NODE_INSTALL_CUDA: "skip", ...base };
}

/** The one line printed after a failed install. */
export function installFailureHint(targetArg) {
  return `If a download was blocked by your network, run inside ${targetArg}: ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`;
}
