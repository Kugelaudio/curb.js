import { describe, expect, it, vi } from "vitest";
import { embeddedPreviewTransport } from "./embedded-transport.js";

describe("embedded preview transport", () => {
  it("only accepts opted-in frames from its same-origin parent", () => {
    const parent = { postMessage: vi.fn() };
    const add = vi.fn();
    const remove = vi.fn();
    const page = {
      parent, location: { origin: "https://example.test" },
      document: { documentElement: { dataset: { curbTransport: "parent" } } },
      addEventListener: add, removeEventListener: remove,
    } as unknown as Window;
    const transport = embeddedPreviewTransport(page)!;
    const receive = vi.fn();
    const disconnect = transport.connect(receive);
    const handle = add.mock.calls[0][1];
    const frame = { type: "running", value: true };
    const envelope = { type: "curb_preview_frame", frame };
    handle({ origin: "https://other.test", source: parent, data: envelope });
    handle({ origin: "https://example.test", source: {}, data: envelope });
    expect(receive).not.toHaveBeenCalled();
    handle({ origin: "https://example.test", source: parent, data: envelope });
    expect(receive).toHaveBeenCalledWith(frame);
    transport.send({ type: "inspect_skill", skill: "/billing" });
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: "curb_preview_ready" }, "https://example.test"],
      [{ type: "curb_preview_action", frame: { type: "inspect_skill", skill: "/billing" } }, "https://example.test"],
    ]);
    disconnect();
    expect(remove).toHaveBeenCalledWith("message", handle);
    delete page.document.documentElement.dataset.curbTransport;
    expect(embeddedPreviewTransport(page)).toBeUndefined();
  });
});
