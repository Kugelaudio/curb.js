import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

/**
 * Replaces the quadratic copy in `@livekit/agents`' `mergeFrames` with one preallocated
 * buffer, in the hosted bundle.
 *
 * Upstream (1.5.2 through 1.9.2) concatenates with `new Int16Array([...data, ...frame.data])`:
 * every frame re-spreads everything merged so far through a JavaScript iterator. Silero VAD
 * merges about four frames twice per 32 ms window, so in a 4-call load test
 * this one function was 9% of the main thread.s busy time; a batch
 * STT merging a whole utterance pays it over hundreds of frames. The replacement returns the
 * same samples in the same order.
 *
 * If a resolved `@livekit/agents` no longer has the slow line (upstream fixed it, or the
 * function changed shape), the file is left alone and the build reports a warning naming
 * it, so a dropped patch is visible rather than silently slower. Curb's own test fails on
 * the installed version first, which is where a dependency bump notices.
 */
export function mergeFramesPlugin(): Plugin {
  return {
    name: "curb:merge-frames",
    setup(build) {
      build.onLoad({ filter: /[\\/]@livekit[\\/]agents[\\/]dist[\\/]utils\.c?js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const patched = patchMergeFrames(source);
        if (patched !== null) return { contents: patched, loader: "js" };
        // KEEP-JUSTIFIED: the unpatched function is correct, only slower; the warning
        // surfaces through the build's unclassified warnings.
        return {
          contents: source,
          loader: "js",
          warnings: [{ text: `curb build: mergeFrames in ${args.path} did not match the known slow form; left unpatched` }],
        };
      });
    },
  };
}

const START = "const mergeFrames = (buffer) => {";
const SLOW_INIT = "let data = new Int16Array();";
const SLOW_CONCAT = "data = new Int16Array([...data, ...frame.data]);";

/** The source with `mergeFrames` rewritten, or null when it is not the known slow form. */
export function patchMergeFrames(source: string): string | null {
  const start = source.indexOf(START);
  if (start === -1) return null;
  const end = source.indexOf("\n};", start);
  if (end === -1) return null;
  const body = source.slice(start, end);
  if (body.split(SLOW_INIT).length !== 2 || body.split(SLOW_CONCAT).length !== 2) return null;
  const fast = body
    .replace(SLOW_INIT, "let data = new Int16Array(buffer.reduce((n, f) => n + f.data.length, 0)); let offset = 0;")
    .replace(SLOW_CONCAT, "data.set(frame.data, offset); offset += frame.data.length;");
  return source.slice(0, start) + fast + source.slice(end);
}
