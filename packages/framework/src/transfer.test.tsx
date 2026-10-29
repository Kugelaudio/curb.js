import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentAuthoringError, AgentSiteRuntime, TransferCallTool, useTransferCall, type TransferCall } from "./index.js";
import type { OutgoingHostMessage } from "./messages.js";
import { CALL_TRANSFER_RESULT_MESSAGE, attachTransferAudio, transferToolResult, type TransferAudio } from "./transfer.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Transfers({ onTransfer }: { onTransfer: (transfer: TransferCall) => void }) {
  onTransfer(useTransferCall());
  return <TransferCallTool to="+493012345678" ringTimeoutSeconds={20} />;
}

/** A runtime on a phone call whose host answers `call.transfer` with `reply`. */
function phoneCall(
  options: {
    reply?: (message: OutgoingHostMessage) => Record<string, unknown> | null;
    phone?: boolean;
    host?: boolean;
    audio?: TransferAudio;
    onSend?: (message: OutgoingHostMessage) => void;
  } = {},
) {
  let transfer: TransferCall | undefined;
  const runtime = new AgentSiteRuntime(
    <Agent>
      <Transfers onTransfer={(value) => (transfer = value)} />
    </Agent>,
  );
  if (options.audio) attachTransferAudio(runtime.info, options.audio);
  if (options.phone !== false) runtime.updateInfo({ "caller.identity": "sip_caller-1", "caller.phoneNumber": "+491701234567" });
  const sent: OutgoingHostMessage[] = [];
  if (options.host !== false) {
    runtime.messages.connectHost((message) => {
      sent.push(message);
      options.onSend?.(message);
      const payload = options.reply?.(message);
      if (payload) {
        queueMicrotask(() => void runtime.messages.deliver("host", { id: "r-1", key: "reply", payload, inReplyTo: message.id }));
      }
      return true;
    });
  }
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return { runtime, sent, errors, transfer: () => transfer! };
}

const result = (runtime: AgentSiteRuntime, payload: Record<string, unknown>) =>
  runtime.messages.deliver("host", { id: "res-1", key: CALL_TRANSFER_RESULT_MESSAGE, payload });

/** The voice host's side of a transfer, recording into `log`; `announce` resolves once `played()` is called. */
function fakeAudio(log: string[]) {
  let played: () => void = () => {};
  const audio: TransferAudio = {
    announce: async (text) => {
      log.push(`announce ${text}`);
      await new Promise<void>((resolve) => (played = resolve));
      log.push("announce played");
    },
    ringback: () => {
      log.push("ringback");
      return () => log.push("ringback stopped");
    },
  };
  return { audio, played: () => played() };
}

const ANNOUNCE = "One moment, I am connecting you to our sales team.";

describe("useTransferCall", () => {
  it("sends call.transfer, then resolves with the matching call.transfer.result", async () => {
    const { runtime, sent, transfer } = phoneCall({ reply: () => ({ transferId: "t-1" }) });
    const pending = transfer()({ to: "+49 30 1234 5678", ringTimeoutSeconds: 15 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ name: "call.transfer", expectsReply: true, payload: { to: "+49 30 1234 5678", ringTimeoutSeconds: 15 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result(runtime, { transferId: "other", outcome: "answered", dialStatus: "ANSWER" });
    await result(runtime, { transferId: "t-1", outcome: "busy", dialStatus: "BUSY" });
    await expect(pending).resolves.toEqual({ outcome: "busy", transferId: "t-1" });
  });

  it("takes a result that arrived with the acceptance", async () => {
    const { runtime, transfer } = phoneCall({
      reply: (message) => {
        queueMicrotask(() => void result(runtime, { transferId: "t-2", outcome: "answered", dialStatus: "ANSWER" }));
        void message;
        return { transferId: "t-2" };
      },
    });
    await expect(transfer()({ to: "+493012345678" })).resolves.toEqual({ outcome: "answered", transferId: "t-2" });
  });

  it("resolves a refusal and logs one line, naming the plan feature for upgrade_required", async () => {
    const { transfer, errors } = phoneCall({
      reply: () => ({ code: "upgrade_required", message: "Upgrade to use outbound calls.", feature: "outbound-calls" }),
    });
    const outcome = await transfer()({ to: "+493012345678" });
    expect(outcome).toMatchObject({ outcome: "refused", code: "upgrade_required" });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("Call transfer needs a paid plan (plan feature outbound-calls)");
  });

  it("refuses outside a phone call without asking the host", async () => {
    const browser = phoneCall({ phone: false });
    const outcome = await browser.transfer()({ to: "+493012345678" });
    expect(outcome).toMatchObject({ outcome: "refused", code: "transfer_unsupported_session" });
    expect(outcome.message).toContain("phone calls only");
    expect(browser.sent).toHaveLength(0);

    const preview = phoneCall({ host: false });
    await expect(preview.transfer()({ to: "+493012345678" })).resolves.toMatchObject({
      outcome: "refused",
      code: "transfer_unsupported_session",
    });
  });

  it("resolves failed transfer_no_reply when the reply or the result never comes", async () => {
    vi.useFakeTimers();
    const silent = phoneCall({ reply: () => null });
    const noReply = silent.transfer()({ to: "+493012345678" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(noReply).resolves.toMatchObject({ outcome: "failed", code: "transfer_no_reply" });

    const accepted = phoneCall({ reply: () => ({ transferId: "t-3" }) });
    const noResult = accepted.transfer()({ to: "+493012345678", ringTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(39_000);
    let settled = false;
    void noResult.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(noResult).resolves.toEqual(expect.objectContaining({ outcome: "failed", code: "transfer_no_reply", transferId: "t-3" }));
  });

  it("says the announcement before it asks for the transfer, then rings until the outcome", async () => {
    const log: string[] = [];
    const { audio, played } = fakeAudio(log);
    const { runtime, transfer } = phoneCall({
      audio,
      reply: () => ({ transferId: "t-5" }),
      onSend: (message) => log.push(`send ${message.name}`),
    });
    const pending = transfer()({ to: "+493012345678", announce: `  ${ANNOUNCE} ` });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Nothing is dialed while the announcement still plays.
    expect(log).toEqual([`announce ${ANNOUNCE}`]);
    played();
    await vi.waitFor(() => expect(log).toContain("send call.transfer"));
    expect(log).toEqual([`announce ${ANNOUNCE}`, "announce played", "ringback", "send call.transfer"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result(runtime, { transferId: "t-5", outcome: "answered", dialStatus: "ANSWER" });
    await expect(pending).resolves.toEqual({ outcome: "answered", transferId: "t-5" });
    expect(log.at(-1)).toBe("ringback stopped");
  });

  it("says nothing without an announcement, but still rings", async () => {
    const log: string[] = [];
    const { audio } = fakeAudio(log);
    const { runtime, sent, transfer } = phoneCall({ audio, reply: () => ({ transferId: "t-6" }) });
    const pending = transfer()({ to: "+493012345678" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload).toEqual({ to: "+493012345678" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result(runtime, { transferId: "t-6", outcome: "no_answer", dialStatus: "NOANSWER" });
    await expect(pending).resolves.toMatchObject({ outcome: "no_answer" });
    expect(log).toEqual(["ringback", "ringback stopped"]);
  });

  it("stops the ringback on every outcome", async () => {
    const cases: Array<{ outcome: string; reply: Record<string, unknown>; result?: Record<string, unknown> }> = [
      { outcome: "answered", reply: { transferId: "t" }, result: { transferId: "t", outcome: "answered" } },
      { outcome: "no_answer", reply: { transferId: "t" }, result: { transferId: "t", outcome: "no_answer" } },
      { outcome: "busy", reply: { transferId: "t" }, result: { transferId: "t", outcome: "busy" } },
      { outcome: "failed", reply: { transferId: "t" }, result: { transferId: "t", outcome: "failed", dialStatus: "FAILED" } },
      { outcome: "refused", reply: { code: "transfer_in_progress", message: "Already transferring." } },
    ];
    for (const { outcome, reply, result: payload } of cases) {
      const log: string[] = [];
      const { audio } = fakeAudio(log);
      const call = phoneCall({ audio, reply: () => reply });
      const pending = call.transfer()({ to: "+493012345678" });
      await vi.waitFor(() => expect(call.sent).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (payload) await result(call.runtime, payload);
      await expect(pending).resolves.toMatchObject({ outcome });
      expect(log, outcome).toEqual(["ringback", "ringback stopped"]);
    }
  });

  it("neither announces nor rings outside a phone call", async () => {
    const log: string[] = [];
    const { audio } = fakeAudio(log);
    const browser = phoneCall({ audio, phone: false });
    await expect(browser.transfer()({ to: "+493012345678", announce: ANNOUNCE })).resolves.toMatchObject({
      outcome: "refused",
    });
    const preview = phoneCall({ audio, host: false });
    await expect(preview.transfer()({ to: "+493012345678", announce: ANNOUNCE })).resolves.toMatchObject({
      outcome: "refused",
    });
    expect(log).toEqual([]);
  });

  it("throws TypeError only for a bad argument", async () => {
    const { transfer } = phoneCall();
    await expect(transfer()({ to: "+493012345678", announce: "   " })).rejects.toBeInstanceOf(TypeError);
    await expect(transfer()({ to: "+493012345678", announce: 42 as unknown as string })).rejects.toBeInstanceOf(TypeError);
    await expect(transfer()({ to: "sales" })).rejects.toBeInstanceOf(TypeError);
    await expect(transfer()({ to: "+493012345678", ringTimeoutSeconds: 5 })).rejects.toBeInstanceOf(TypeError);
    await expect(transfer()({ to: "+493012345678", ringTimeoutSeconds: 12.5 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("TransferCallTool", () => {
  it("transfers and tells the model the outcome in plain words", async () => {
    const { runtime, sent } = phoneCall({ reply: () => ({ transferId: "t-4" }) });
    expect(runtime.snapshot().context.tools.map((tool) => tool.name)).toContain("transfer_call");
    const call = runtime.callTool("transfer_call", { announce: ANNOUNCE });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload).toEqual({ to: "+493012345678", ringTimeoutSeconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result(runtime, { transferId: "t-4", outcome: "no_answer", dialStatus: "NOANSWER" });
    const { result: toolResult } = await call;
    expect(toolResult.message).toContain("Nobody answered");
  });

  it("asks the model for its announcement and says it before dialing", async () => {
    const log: string[] = [];
    const { audio, played } = fakeAudio(log);
    const { runtime, sent } = phoneCall({ audio, reply: () => ({ transferId: "t-8" }) });
    const definition = runtime.snapshot().context.tools.find((tool) => tool.name === "transfer_call")!;
    expect(definition.inputSchema).toMatchObject({ required: ["announce"], properties: { announce: { type: "string" } } });
    const announceField = (definition.inputSchema.properties as Record<string, { description?: string }>).announce!;
    expect(announceField.description).toContain("before");
    const call = runtime.callTool("transfer_call", { announce: ANNOUNCE });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual([`announce ${ANNOUNCE}`]);
    expect(sent).toHaveLength(0);
    played();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload).toEqual({ to: "+493012345678", ringTimeoutSeconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result(runtime, { transferId: "t-8", outcome: "busy", dialStatus: "BUSY" });
    expect((await call).result.message).toContain("busy");
    expect(log).toEqual([`announce ${ANNOUNCE}`, "announce played", "ringback", "ringback stopped"]);
  });

  it("refuses a call without an announcement, so the model calls again with one", async () => {
    const log: string[] = [];
    const { audio } = fakeAudio(log);
    const { runtime, sent } = phoneCall({ audio, reply: () => ({ transferId: "t-9" }) });
    for (const input of [{}, { announce: "" }, { announce: "   " }]) {
      const { result: refusal } = await runtime.callTool("transfer_call", input);
      expect(refusal.ok).toBe(false);
      expect(refusal.message).toContain("announce");
      expect(refusal.message).toContain("Nobody was called");
    }
    expect(sent).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it("says each outcome so the model can tell the caller", () => {
    expect(transferToolResult({ outcome: "answered" }).message).toContain("call skip_turn");
    expect(transferToolResult({ outcome: "busy" }).message).toContain("busy");
    expect(transferToolResult({ outcome: "refused", code: "transfer_unsupported_session" }).message).toContain("phone call");
  });

  it("refuses a bad number when it renders", () => {
    expect(() => new AgentSiteRuntime(<Agent><TransferCallTool to="claims" /></Agent>)).toThrow(AgentAuthoringError);
  });
});
