/**
 * Classification of dependency-tracing warnings.
 *
 * The tracer emits ~90 warnings for a typical project, and every one of them is
 * benign. That is the problem: a real missing module -- which becomes
 * MODULE_NOT_FOUND inside a live call -- would be indistinguishable from the noise,
 * so the list gets ignored wholesale and the one that mattered goes with it.
 *
 * These classes are therefore counted rather than printed, and anything that matches
 * none of them is surfaced individually. Suppression is by NAMED CLASS with a stated
 * reason, never a blanket filter: a new kind of failure stays loud.
 */


export type WarningClass =
  | "platform-variant"
  | "sharp-build-probe"
  | "unparseable-text"
  | "optional-accelerator"
  | "unclassified";

export type ClassifiedWarning = {
  text: string;
  class: WarningClass;
};

/**
 * Optional native accelerators for `ws`. It falls back to pure JavaScript when they
 * are absent, so their absence costs throughput and nothing else.
 */
const OPTIONAL_ACCELERATORS = ["bufferutil", "utf-8-validate"];

/**
 * A per-platform artifact for an OS/arch that is not this one.
 *
 * napi-rs packages probe every platform's binding in turn and load the one that
 * resolves; the other twenty are expected to fail. Matching on the platform token
 * rather than on the package name keeps this working when a new binding package is
 * added upstream.
 */
const PLATFORM_TOKEN =
  /(android|win32|darwin|linux(?:musl)?|freebsd|openharmony|wasm32|wasi)(-|\.|\/|$)/;

/** Build-only paths assembled dynamically by sharp; production prebuilds never load them. */
const SHARP_BUILD_PROBE =
  /^@img\/sharp-(?:libvips-dev\/(?:include|cplusplus)|libvips-[^/]*\/package)$/;

/** The tracer parses candidate files as JS; licences and notices are neither. */
const UNPARSEABLE = /Failed to parse .*(LICENSE|NOTICE|README|\.md|\.txt)/i;

export function classifyWarning(text: string): WarningClass {
  const dependency = /Failed to resolve dependency "([^"]+)"/.exec(text)?.[1] ?? text;

  if (UNPARSEABLE.test(text)) return "unparseable-text";
  if (OPTIONAL_ACCELERATORS.includes(dependency)) return "optional-accelerator";
  if (SHARP_BUILD_PROBE.test(dependency)) return "sharp-build-probe";
  if (PLATFORM_TOKEN.test(dependency)) return "platform-variant";
  return "unclassified";
}

export type WarningSummary = {
  counts: Record<WarningClass, number>;
  /** Warnings matching no known-benign class. These are printed in full. */
  unclassified: string[];
};

export function summarizeWarnings(warnings: string[]): WarningSummary {
  const counts: Record<WarningClass, number> = {
    "platform-variant": 0,
    "sharp-build-probe": 0,
    "unparseable-text": 0,
    "optional-accelerator": 0,
    unclassified: 0,
  };
  const unclassified: string[] = [];

  for (const warning of warnings) {
    const cls = classifyWarning(warning);
    counts[cls] += 1;
    if (cls === "unclassified") unclassified.push(warning);
  }

  return { counts, unclassified };
}

/** One line per benign class, explaining why it is safe to ignore. */
export const CLASS_EXPLANATION: Record<Exclude<WarningClass, "unclassified">, string> = {
  "platform-variant": "per-platform binding for another OS/arch (napi probes all, loads one)",
  "sharp-build-probe": "sharp build-only path; packaged prebuilds do not load it at runtime",
  "unparseable-text": "licence or notice file the tracer tried to parse as JavaScript",
  "optional-accelerator": "optional native speedup; ws falls back to pure JavaScript",
};
