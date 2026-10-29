import { describe, expect, it } from "vitest";
import { hostBuildTarget } from "./build-target.js";

describe("hostBuildTarget", () => {
  it("omits libc rather than guessing one off Linux", () => {
    const target = hostBuildTarget();

    // "I do not know" has to stay distinct from "gnu": the platform compares libc
    // only when BOTH sides state one, and a guessed value there would refuse a
    // runnable artifact instead of admitting ignorance.
    if (process.platform !== "linux") {
      expect(target.libc).toBeUndefined();
      expect("libc" in target).toBe(false);
    } else {
      // On Linux it is either detected from the loader or absent -- never invented.
      expect(target.libc === undefined || ["gnu", "musl"].includes(target.libc)).toBe(true);
    }
  });

});
