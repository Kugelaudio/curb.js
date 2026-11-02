import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.resetModules());

describe("the bundled synchronizer module", () => {
  it("is what a call uses, with no package lookup, as in a built artifact", async () => {
    const { createSynchronizer, setBundledSynchronizerModule } = await import("./synchronizer.js");
    const constructed = vi.fn();
    class TranscriptionSynchronizer {
      constructor(...args: unknown[]) {
        constructed(...args);
      }
    }
    setBundledSynchronizerModule({
      TranscriptionSynchronizer: TranscriptionSynchronizer as never,
      defaultTextSyncOptions: { speed: 1 },
    });
    const [audio, text] = [{}, {}];
    await createSynchronizer(audio as never, text as never);
    expect(constructed).toHaveBeenCalledWith(audio, text, { speed: 1 });
  });

  it("is refused when it no longer has what a call needs", async () => {
    const { setBundledSynchronizerModule } = await import("./synchronizer.js");
    expect(() => setBundledSynchronizerModule({})).toThrow(/no longer has TranscriptionSynchronizer/);
  });
});
