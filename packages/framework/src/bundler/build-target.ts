import { existsSync, readdirSync } from "node:fs";

/**
 * The (os, architecture, libc) triple an artifact is built for.
 *
 * A bundle vendors platform-specific native prebuilds, so one built for a given pair is
 * not portable to another, so the manifest records it and a runner rejects a mismatch.
 */
export interface BuildTarget {
  os: string;
  architecture: string;
  /** Omitted when it cannot be determined — never guessed. See {@link hostLibc}. */
  libc?: string;
}

/**
 * Reports the C library this host's native modules are built against.
 *
 * Only meaningful on Linux, where one (os, arch) pair ships two incompatible prebuild
 * families. Detected from the dynamic loader rather than a distribution file, because the
 * loader is what actually fails to resolve the binding — this is deliberately the same
 * method the platform's executor uses to describe itself, so the two agree by
 * construction rather than by coincidence.
 *
 * Returns undefined when undetectable: "I do not know" is a distinct answer from "gnu",
 * and the comparison declines to judge rather than refusing a runnable artifact.
 */
function hostLibc(): string | undefined {
  if (process.platform !== "linux") return undefined;

  try {
    if (readdirSync("/lib").some((entry) => /^ld-musl-.*\.so\.1$/.test(entry))) return "musl";
  } catch {
    // KEEP-JUSTIFIED: /lib being unreadable is not evidence of either libc. Fall through
    // to the glibc probe, and report undefined if that is inconclusive too.
  }

  const glibcLoaders = [
    "/lib64/ld-linux-x86-64.so.2",
    "/lib/ld-linux-aarch64.so.1",
    "/lib/ld-linux-x86-64.so.2",
  ];
  if (glibcLoaders.some((loader) => existsSync(loader))) return "gnu";

  return undefined;
}

/**
 * The target of the machine running `curb build`.
 *
 * `os` and `architecture` are reported in Node's vocabulary (`darwin`, `win32`, `x64`,
 * `arm64`); the consumer translates them. Emitting what this runtime actually says keeps
 * a mismatch message truthful about what the manifest recorded.
 */
export function hostBuildTarget(): BuildTarget {
  const libc = hostLibc();
  return {
    os: process.platform,
    architecture: process.arch,
    ...(libc ? { libc } : {}),
  };
}
