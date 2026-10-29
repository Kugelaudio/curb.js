import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  Agent,
  AgentAuthoringError,
  AgentSiteRuntime,
  HostTimeoutError,
  HostUnavailableError,
  MessageRefusedError,
  Tool,
  useMessage,
  useSend,
  z,
  type MessageSender,
} from "./index.js";
import {
  AppMessages,
  type OutgoingClientMessage,
  type OutgoingHostMessage,
} from "./messages.js";

afterEach(() => {
  vi.useRealTimers();
});

let ids = 0;
const newId = () => `m-${++ids}`;

function hub(options: ConstructorParameters<typeof AppMessages>[0] = {}) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const messages = new AppMessages({
    newId,
    warn: (line) => warnings.push(line),
    error: (line) => errors.push(line),
    ...options,
  });
  return { messages, warnings, errors };
}

function hostConnected(messages: AppMessages): OutgoingHostMessage[] {
  const sent: OutgoingHostMessage[] = [];
  messages.connectHost((message) => {
    sent.push(message);
    return true;
  });
  return sent;
}

async function refusal(pending: Promise<unknown>): Promise<MessageRefusedError> {
  const error = await pending.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MessageRefusedError);
  return error as MessageRefusedError;
}

describe("AppMessages: sending", () => {
  it("publishes toHost without expecting a reply", () => {
    const { messages } = hub({ newId: () => "n-1" });
    const sent = hostConnected(messages);
    messages.send.toHost("lead", { score: 0.9 });
    expect(sent).toEqual([{ id: "n-1", name: "lead", payload: { score: 0.9 }, expectsReply: false }]);
  });

  it("publishes toClient as { key, id, payload }", () => {
    const { messages } = hub({ newId: () => "c-1" });
    const sent: OutgoingClientMessage[] = [];
    messages.connectClient((message) => {
      sent.push(message);
      return "sent";
    });
    messages.send.toClient("show-form", { form: "claim" });
    expect(sent).toEqual([{ id: "c-1", key: "show-form", payload: { form: "claim" } }]);
  });

  it("drops toClient with no app yet and on a phone call, warning once per key AND reason, and counts per key", () => {
    const { messages, warnings } = hub();
    // Nothing connected yet: no client app has joined.
    messages.send.toClient("show-form");
    messages.send.toClient("show-form");
    // Connected, but nobody is in the room yet: the same reason, so no second warning.
    let reach: "no_client_yet" | "phone_call" = "no_client_yet";
    messages.connectClient(() => reach);
    messages.send.toClient("show-form");
    // Only a phone caller: a different reason, its own once-per-key warning.
    reach = "phone_call";
    messages.send.toClient("show-form");
    messages.send.toClient("show-summary");
    expect(messages.undeliveredCounts()).toEqual({ toClient: { "show-form": 4, "show-summary": 1 }, toHost: {} });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('send.toClient("show-form") was dropped: no client app has joined this call yet');
    expect(warnings[1]).toContain('send.toClient("show-form") was dropped: this call has no client data channel (a phone call)');
    expect(warnings[2]).toContain('"show-summary"');
  });

  it("records every toClient that left, and every reply to a client's ask, when a recorder is connected", () => {
    const { messages } = hub({ newId: () => "c-9" });
    const records: unknown[] = [];
    messages.connectClient(() => "sent");
    messages.send.toClient("before-recorder");
    messages.connectRecorder((traffic) => void records.push(traffic));
    messages.send.toClient("show-form", { form: "claim" });
    messages.recordReplyToClient("quote", "q-1", { price: 12 });
    messages.connectClient(() => "phone_call");
    messages.send.toClient("dropped");
    expect(records).toEqual([
      { kind: "message_to_client", key: "show-form", id: "c-9", payload: { form: "claim" } },
      { kind: "reply_to_client", key: "quote", id: "q-1", reply: { price: 12 } },
    ]);
  });

  it("drops toHost with no host connected, warns once per key, and counts", () => {
    const { messages, warnings } = hub();
    messages.send.toHost("lead");
    messages.send.toHost("lead");
    expect(messages.undeliveredCounts()).toEqual({ toClient: {}, toHost: { lead: 2 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no host is connected");
  });

  it("accepts any key up to 256 characters and refuses others with an agent-readable error", () => {
    const { messages } = hub();
    hostConnected(messages);
    expect(() => messages.send.toHost("Not Dotted At All")).not.toThrow();
    expect(() => messages.send.toHost("k".repeat(256))).not.toThrow();
    expect(() => messages.send.toHost("")).toThrow(AgentAuthoringError);
    expect(() => messages.send.toHost("k".repeat(257))).toThrow(/AGENT_INVALID_AUTHORING_PROP[\s\S]*Fix:/);
    expect(() => messages.send.toClient("ok", [] as never)).toThrow(AgentAuthoringError);
    expect(() => messages.send.askHost("ok", {}, { timeoutMs: 0 })).toThrow(AgentAuthoringError);
  });
});

describe("AppMessages: askHost", () => {
  it("rejects HostUnavailableError when no host is connected", async () => {
    const { messages } = hub();
    await expect(messages.send.askHost("human.requested")).rejects.toBeInstanceOf(HostUnavailableError);
  });

  it("resolves with the payload of the host message that replies to it, and needs no handler", async () => {
    const { messages } = hub({ newId: () => "r-1" });
    const sent = hostConnected(messages);
    const answer = messages.send.askHost("human.requested", { topic: "refund" });
    expect(sent[0]).toMatchObject({ id: "r-1", name: "human.requested", expectsReply: true });

    await expect(
      messages.deliver("host", { id: "h-1", key: "human.decision", payload: { ok: true }, inReplyTo: "r-1" }),
    ).resolves.toEqual({});
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("never resolves from a client message, even one naming the ask", async () => {
    vi.useFakeTimers();
    const { messages } = hub({ newId: () => "r-2" });
    hostConnected(messages);
    const answer = messages.send.askHost("human.requested", {}, { timeoutMs: 50 });
    const settled = expect(answer).rejects.toBeInstanceOf(HostTimeoutError);
    expect((await refusal(messages.deliver("client", { id: "x", key: "human.decision", payload: {}, inReplyTo: "r-2" }))).code).toBe("no_handler");
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  it("defaults the timeout to 10000 ms", async () => {
    vi.useFakeTimers();
    const { messages } = hub();
    hostConnected(messages);
    let outcome: unknown = "pending";
    messages.send.askHost("human.requested").catch((error: unknown) => (outcome = error));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(HostTimeoutError);
  });

  it("rejects a waiting ask when the host detaches or refuses the message", async () => {
    const { messages } = hub();
    hostConnected(messages);
    const waiting = messages.send.askHost("human.requested");
    messages.connectHost(null);
    await expect(waiting).rejects.toBeInstanceOf(HostUnavailableError);

    messages.connectHost(() => false);
    await expect(messages.send.askHost("human.requested")).rejects.toBeInstanceOf(HostUnavailableError);
  });
});

describe("AppMessages: receiving", () => {
  it("filters by origin: a client handler never sees a host message and vice versa", async () => {
    const { messages } = hub();
    const seen: string[] = [];
    messages.subscribe("client", "ping", { onMessage: (_p, meta) => void seen.push(`client:${meta.id}`) });
    messages.subscribe("host", "ping", { onMessage: (_p, meta) => void seen.push(`host:${meta.id}`) });

    await messages.deliver("client", { id: "1", key: "ping", payload: {} });
    await messages.deliver("host", { id: "2", key: "ping", payload: {} });
    expect(seen).toEqual(["client:1", "host:2"]);
  });

  it("refuses no_handler when nothing listens for the key from that origin", async () => {
    const { messages } = hub();
    messages.subscribe("host", "ping", { onMessage: () => {} });
    const error = await refusal(messages.deliver("client", { id: "1", key: "ping", payload: {} }));
    expect(error).toMatchObject({ code: "no_handler", key: "ping", from: "client" });
  });

  it("validates with the schema: parsed payload in, invalid_payload with issues out", async () => {
    const { messages } = hub();
    const seen: unknown[] = [];
    messages.subscribe("client", "claim-submitted", {
      schema: z.object({ claimId: z.string() }),
      onMessage: (payload) => void seen.push(payload),
    });

    await messages.deliver("client", { id: "1", key: "claim-submitted", payload: { claimId: "C-1", extra: 1 } });
    expect(seen).toEqual([{ claimId: "C-1" }]);

    const error = await refusal(messages.deliver("client", { id: "2", key: "claim-submitted", payload: { claimId: 7 } }));
    expect(error.code).toBe("invalid_payload");
    expect(error.issues).toEqual([{ path: ["claimId"], message: expect.any(String) }]);
    expect(seen).toHaveLength(1);
  });

  it("replies with the handler's return value, awaited", async () => {
    const { messages } = hub();
    messages.subscribe("client", "quote", { onMessage: async () => ({ price: 42 }) });
    await expect(messages.deliver("client", { id: "1", key: "quote", payload: {} })).resolves.toEqual({
      reply: { price: 42 },
    });
  });

  it("refuses handler_failed when a handler throws, after running the others", async () => {
    const { messages, errors } = hub();
    const seen: string[] = [];
    messages.subscribe("host", "ops.notice", {
      onMessage: () => {
        throw new Error("handler bug");
      },
    });
    messages.subscribe("host", "ops.notice", { onMessage: (_p, meta) => void seen.push(meta.id) });
    const error = await refusal(messages.deliver("host", { id: "h-1", key: "ops.notice", payload: {} }));
    expect(error.code).toBe("handler_failed");
    expect((error.cause as Error).message).toBe("handler bug");
    expect(seen).toEqual(["h-1"]);
    expect(errors).toHaveLength(1);
  });
});

describe("useSend / useMessage inside a runtime", () => {
  function Claims({ onSend }: { onSend: (send: MessageSender) => void }) {
    const send = useSend();
    onSend(send);
    const [claimId, setClaimId] = useState<string | null>(null);
    useMessage("claim-submitted", {
      from: "client",
      schema: z.object({ claimId: z.string() }),
      onMessage: ({ claimId: id }) => {
        setClaimId(id);
        return { received: id };
      },
    });
    return (
      <>
        {claimId ? `Claim submitted: ${claimId}` : "No claim yet."}
        <Tool
          name="ask_supervisor"
          description="Ask a human supervisor."
          onCall={async () => {
            const answer = await send.askHost("human.requested", { topic: "refund" });
            return { ok: true, data: answer };
          }}
        />
      </>
    );
  }

  function build() {
    let send: MessageSender | undefined;
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Claims onSend={(value) => (send = value)} />
      </Agent>,
    );
    return { runtime, send: () => send! };
  }

  it("gives each runtime its own hub", () => {
    const a = build();
    const b = build();
    expect(a.send()).not.toBe(b.send());
    expect(a.send()).toBe(a.runtime.messages.send);
  });

  it("delivers a client message to the mounted handler, replies, and recompiles the context", async () => {
    const { runtime } = build();
    await expect(
      runtime.messages.deliver("client", { id: "c-1", key: "claim-submitted", payload: { claimId: "C-9" } }),
    ).resolves.toEqual({ reply: { received: "C-9" } });
    expect(runtime.snapshot().stateSnapshot.join("\n")).toContain("Claim submitted: C-9");
  });

  it("lets a tool wait for the host's reply", async () => {
    const { runtime } = build();
    const sent: OutgoingHostMessage[] = [];
    runtime.messages.connectHost((message) => {
      sent.push(message);
      queueMicrotask(() => {
        void runtime.messages.deliver("host", {
          id: "h-9",
          key: "human.decision",
          payload: { disposition: "allowed" },
          inReplyTo: message.id,
        });
      });
      return true;
    });
    const { result } = await runtime.callTool("ask_supervisor");
    expect(sent).toHaveLength(1);
    expect(result).toEqual({ ok: true, data: { disposition: "allowed" } });
  });

  it("throws an agent-readable error for an invalid key or origin", () => {
    function BadKey() {
      useMessage("", { from: "client", onMessage: () => {} });
      return null;
    }
    function BadOrigin() {
      useMessage("ok", { from: "server" as never, onMessage: () => {} });
      return null;
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => new AgentSiteRuntime(<Agent><BadKey /></Agent>)).toThrow(AgentAuthoringError);
    expect(() => new AgentSiteRuntime(<Agent><BadOrigin /></Agent>)).toThrow(AgentAuthoringError);
    const reported = logged.mock.calls.flat().map(String).join("\n");
    logged.mockRestore();
    expect(reported).toContain('"" is not a message key');
    expect(reported).toContain('from must be "client" or "host"');
  });

  it("stops calling a handler once its component unmounts", async () => {
    const seen: string[] = [];
    function Listener() {
      useMessage("ops.notice", { from: "host", onMessage: (_payload, meta) => void seen.push(meta.id) });
      return null;
    }
    let show = true;
    const runtime = new AgentSiteRuntime(() => (
      <Agent>
        {show ? <Listener /> : null}
      </Agent>
    ));
    await runtime.messages.deliver("host", { id: "h-1", key: "ops.notice", payload: {} });
    show = false;
    runtime.refreshExternal();
    const error = await refusal(runtime.messages.deliver("host", { id: "h-2", key: "ops.notice", payload: {} }));
    expect(error.code).toBe("no_handler");
    expect(seen).toEqual(["h-1"]);
  });
});
