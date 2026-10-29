import { createHash } from "node:crypto";
import type { ExperimentDeclaration } from "./experiments.js";

/**
 * Which variant of an experiment a call gets. The SAME rule the hosting platform assigns hosted
 * calls by, in Go; both implementations test the same golden vectors, so a variant `curb dev`
 * draws for a session id is the one the platform would draw for it.
 *
 * 1. When the experiment has `fromClient` and the call's client context holds that key with a
 *    value that names one of its variants, that variant ({@link forcedVariant}).
 * 2. Otherwise the draw ({@link drawnVariant}): `h` is the first 8 bytes of
 *    SHA-256(`<sessionId>:<experimentName>`) read as a big-endian uint64, `r = h mod totalWeight`,
 *    and the variants are walked in manifest order (sorted by name), subtracting each weight; the
 *    first variant with `r < weight` wins.
 *
 * Node-only (`node:crypto`), so it stays out of everything the browser imports.
 */

/** The client context of a call: what its page sent, by key without `client.`. */
export type ClientContext = Readonly<Record<string, string | undefined>>;

/** Step 1: the variant the call's client context names through `fromClient`, or undefined. */
export function forcedVariant(experiment: ExperimentDeclaration, clientContext: ClientContext = {}): string | undefined {
  const key = experiment.fromClient;
  if (key === undefined || !Object.hasOwn(clientContext, key)) return undefined;
  const value = clientContext[key];
  return experiment.variants.some((variant) => variant.name === value) ? value : undefined;
}

/** Step 2: the variant the session draws, by weight. `experiment.variants` is in manifest order. */
export function drawnVariant(sessionId: string, experiment: ExperimentDeclaration): string {
  const total = experiment.variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (experiment.variants.length === 0 || total <= 0) {
    throw new Error(`curb: experiment "${experiment.name}" has no variant with a weight to draw from.`);
  }
  const hash = createHash("sha256").update(`${sessionId}:${experiment.name}`, "utf8").digest().readBigUInt64BE(0);
  let rest = Number(hash % BigInt(total));
  for (const variant of experiment.variants) {
    if (rest < variant.weight) return variant.name;
    rest -= variant.weight;
  }
  // Unreachable: `rest` starts below the sum of the weights it is walked down by.
  throw new Error(`curb: experiment "${experiment.name}" drew past its last variant.`);
}

/** The variant one session gets in one experiment: forced, else drawn. */
export function assignVariant(
  sessionId: string,
  experiment: ExperimentDeclaration,
  clientContext: ClientContext = {},
): string {
  return forcedVariant(experiment, clientContext) ?? drawnVariant(sessionId, experiment);
}

/** Every experiment's variant for one session, by experiment name. */
export function assignExperiments(
  experiments: readonly ExperimentDeclaration[],
  sessionId: string,
  clientContext: ClientContext = {},
): Record<string, string> {
  return Object.fromEntries(
    experiments.map((experiment) => [experiment.name, assignVariant(sessionId, experiment, clientContext)]),
  );
}
