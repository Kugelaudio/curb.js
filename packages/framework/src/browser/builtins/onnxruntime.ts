/**
 * `onnxruntime-node` on ONNX Runtime Web (WASM, one thread: no SharedArrayBuffer).
 *
 * The node API opens a model by file path; here the path names a file the dev server serves
 * under `/curb-assets/` (Silero's `silero_vad.onnx`). The runtime's own WASM is served under
 * `/ort/`.
 */

import * as ort from "onnxruntime-web/wasm";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL("/ort/", location.origin).href;

async function create(model: string | Uint8Array, options?: ort.InferenceSession.SessionOptions) {
  const bytes =
    typeof model === "string"
      ? await fetch(new URL(`/curb-assets/${model.split("/").pop()}`, location.origin)).then(async (response) => {
          if (!response.ok) throw new Error(`onnxruntime: the model ${model} is not served (HTTP ${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        })
      : model;
  // Threads and execution providers are the node runtime's options; the browser has one of each.
  const { intraOpNumThreads: _intra, interOpNumThreads: _inter, executionProviders: _providers, ...rest } = options ?? {};
  return ort.InferenceSession.create(bytes, { ...rest, executionProviders: ["wasm"] });
}

export const InferenceSession = { create };
export const Tensor = ort.Tensor;
export const env = ort.env;
export default { InferenceSession, Tensor, env };
