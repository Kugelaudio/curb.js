import { describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Text, useSession } from "../index.js";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { ConnectionController, type AgentSessionBundle } from "./connection.js";
import type { ServerMessage } from "./protocol.js";

/**
 * `useSession().call` in `curb dev`: every preview conversation is a call with an identity,
 * typed or spoken, as it is on every hosted route. A rewind is the same conversation, so it
 * keeps it; a new conversation gets its own.
 */

function CallProbe() {
  const { call } = useSession();
  return <Text>{call ? `call ${call.sessionId}` : "no call"}</Text>;
}

function probeBundle(llm: AgentLlmClient): AgentSessionBundle {
  const runtime = new AgentSiteRuntime(() => (
    <Agent>
      <CallProbe />
    </Agent>
  ));
  return { runtime, session: new AgentSession(runtime, llm) };
}

/** The call the agent rendered in the newest context frame. */
function renderedCall(sent: ServerMessage[]): string | null {
  const frame = sent.filter((message) => message.type === "context").at(-1);
  if (!frame || frame.type !== "context") throw new Error("no context frame");
  return /call (\S+)/.exec(frame.stateSnapshot.join("\n"))?.[1] ?? null;
}

function previewConnection() {
  const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Sure.", toolCalls: [] }));
  const created: AgentSessionBundle[] = [];
  const create = vi.fn(async () => {
    const bundle = probeBundle(llm);
    created.push(bundle);
    return bundle;
  });
  const initial = probeBundle(llm);
  const sent: ServerMessage[] = [];
  const voiceStarts: AgentSessionBundle[] = [];
  const close = vi.fn(async () => {});
  const controller = new ConnectionController((message) => sent.push(message), {
    ...initial,
    agentHost: {
      ids: ["probe", "other"],
      initialId: "probe",
      create,
      createRuntime: async () => probeBundle(llm).runtime,
      preview: (id) => ({ id, source: "", preview: {}, skills: [] }),
    },
    voiceHost: {
      start: async ({ bundle }) => {
        voiceStarts.push(bundle);
        return {
          transport: "livekit" as const,
          url: "ws://livekit.local",
          token: "tok",
          room: "curb-abc",
          sendText: vi.fn(async () => {}),
          setBundle: vi.fn(),
          interrupt: vi.fn(),
          close,
        };
      },
    },
  });
  controller.start();
  return { controller, sent, initial, create, created, voiceStarts, close };
}

describe("a preview conversation's call identity", () => {
  it("is there for typed chat, before any voice is attached", () => {
    const { sent } = previewConnection();
    expect(renderedCall(sent)).toMatch(/^preview-[0-9a-f-]{36}$/);
  });

  it("is the one a voice call on the conversation runs with", async () => {
    const { controller, sent, initial, voiceStarts } = previewConnection();
    const typed = renderedCall(sent);

    await controller.handle({ type: "voice_start" });
    expect(voiceStarts).toHaveLength(1);
    expect(voiceStarts[0]!.runtime).toBe(initial.runtime);
    expect(renderedCall(sent)).toBe(typed);
  });

  it("survives a rewind, and a new conversation or agent gets its own", async () => {
    const { controller, sent } = previewConnection();
    const first = renderedCall(sent);
    await controller.handle({ type: "user_text", text: "hello" });

    await controller.handle({ type: "rewind", index: 0, rerun: false });
    expect(renderedCall(sent)).toBe(first);

    await controller.handle({ type: "reset" });
    const second = renderedCall(sent);
    expect(second).toMatch(/^preview-/);
    expect(second).not.toBe(first);

    await controller.handle({ type: "select_agent", id: "other" });
    const third = renderedCall(sent);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it.each([{ type: "reset" }, { type: "select_agent", id: "other" }] as const)(
    "keeps the newly selected conversation and call when $type finishes late",
    async (request) => {
      const { controller, sent, initial, create, voiceStarts, close } = previewConnection();
      const initialId = sent.find((message) => message.type === "conversations")!.active;
      await controller.handle({ type: "reset" });

      let releaseBundle!: (bundle: AgentSessionBundle) => void;
      create.mockReturnValueOnce(new Promise((resolve) => { releaseBundle = resolve; }));
      const olderSelection = controller.handle(request);
      expect(create).toHaveBeenCalledTimes(2);

      await controller.handle({ type: "select_conversation", id: initialId });
      await controller.handle({ type: "voice_start" });
      expect(voiceStarts[0]?.session).toBe(initial.session);
      expect(sent.at(-1)).toMatchObject({ type: "voice_session", live: true });
      const framesBeforeRelease = sent.length;

      releaseBundle(probeBundle(async () => ({ text: "Sure.", toolCalls: [] })));
      await olderSelection;

      expect.soft(close).not.toHaveBeenCalled();
      expect.soft(sent.slice(framesBeforeRelease)).not.toContainEqual({ type: "voice_session", live: false });
      expect(sent.filter((message) => message.type === "conversations").at(-1)?.active).toBe(initialId);
    },
  );
});
