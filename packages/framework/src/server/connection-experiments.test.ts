import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { experimentDeclarations } from "../experiments.js";
import type { AgentSiteRuntime } from "../runtime.js";
import { createInsuranceDemoRuntime } from "../test-fixtures/insurance-runtime.js";
import { ConnectionController, previewExperimentUpdate } from "./connection.js";
import type { ConversationState } from "./conversation-restore.js";
import type { PreviewAgent, ServerMessage } from "./protocol.js";

/**
 * `curb dev` draws each preview conversation's experiment variants itself, by the hosting
 * platform's rule over the conversation's own session id; a page's `client.<fromClient>` picks one.
 */

const experiments = experimentDeclarations({
  greeting: { variants: { formal: 1, casual: 1 }, fromClient: "greeting" },
});
const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });

describe("previewExperimentUpdate", () => {
  it("draws a variant the conversation does not have, by the platform's rule", () => {
    // The golden vector: sess_golden draws casual.
    expect(previewExperimentUpdate(experiments, "sess_golden", {})).toEqual({ "experiment.greeting": "casual" });
  });

  it("lets the page's client.<fromClient> pick a variant, over one the conversation has", () => {
    expect(previewExperimentUpdate(experiments, "sess_golden", { "client.greeting": "formal" })).toEqual({
      "experiment.greeting": "formal",
    });
    expect(
      previewExperimentUpdate(experiments, "sess_golden", { "experiment.greeting": "casual", "client.greeting": "formal" }),
    ).toEqual({ "experiment.greeting": "formal" });
  });

  it("keeps a declared variant the conversation has, and draws again for one it no longer declares", () => {
    expect(previewExperimentUpdate(experiments, "sess_golden", { "experiment.greeting": "formal" })).toEqual({});
    expect(previewExperimentUpdate(experiments, "sess_golden", { "experiment.greeting": "loud" })).toEqual({
      "experiment.greeting": "casual",
    });
  });

  it("removes the variant of an experiment the agent no longer declares", () => {
    expect(previewExperimentUpdate([], "sess_golden", { "experiment.old": "a", "client.greeting": "formal" })).toEqual({
      "experiment.old": undefined,
    });
  });
});

/** A connection whose agent declares the greeting experiment; `bundles` is every one it built. */
function experimentController(history?: ConstructorParameters<typeof ConnectionController>[1]["history"]) {
  const bundles: Array<{ runtime: AgentSiteRuntime; session: AgentSession }> = [];
  const create = vi.fn(async () => {
    const runtime = createInsuranceDemoRuntime();
    const bundle = { runtime, session: new AgentSession(runtime, idleLlm) };
    bundles.push(bundle);
    return bundle;
  });
  const preview = (id: string): PreviewAgent => ({ id, source: "", preview: {}, skills: [], experiments });
  const runtime = createInsuranceDemoRuntime();
  const session = new AgentSession(runtime, idleLlm);
  const sent: ServerMessage[] = [];
  const controller = new ConnectionController((message) => sent.push(message), {
    runtime,
    session,
    agentHost: { ids: ["insurance"], initialId: "insurance", create, createRuntime: async () => runtime, preview },
    ...(history ? { history } : {}),
  });
  return { controller, runtime, session, bundles };
}

const variantOf = (runtime: AgentSiteRuntime) => runtime.info.snapshot()["experiment.greeting"];

describe("a preview conversation's experiment variants", () => {
  it("are drawn before its first turn, and the page's info can pick one", async () => {
    const { controller, runtime, session } = experimentController();
    expect(["formal", "casual"]).toContain(variantOf(runtime));

    const other = variantOf(runtime) === "formal" ? "casual" : "formal";
    await controller.handle({ type: "set_info", values: { "client.greeting": other } });
    expect(variantOf(runtime)).toBe(other);
    expect(runtime.info.snapshot()["client.greeting"]).toBe(other);
    // The page's info and the variant it picked are one change to the conversation.
    expect(session.messages.filter((message) => message.role === "user" && message.kind === "context_event").length).toBeLessThanOrEqual(1);

    // A value naming no variant leaves the conversation's own.
    await controller.handle({ type: "set_info", values: { "client.greeting": "loud" } });
    expect(variantOf(runtime)).toBe(other);
  });

  it("are drawn for every new conversation, with the page's info", async () => {
    const { controller, bundles } = experimentController();
    await controller.handle({ type: "set_info", values: { "client.greeting": "formal" } });
    await controller.handle({ type: "reset" });
    expect(bundles).toHaveLength(1);
    expect(variantOf(bundles[0]!.runtime)).toBe("formal");
  });

  it("are the ones a conversation ran with when curb dev resumes it after a reload", async () => {
    const state: ConversationState = { loadedSkills: [], stores: {}, experiments: { greeting: "formal" } };
    const history = {
      list: () => [{ id: 42, agentId: "insurance", startedAt: Date.now() - 60_000, messageCount: 2 }],
      messages: () => [
        { role: "user" as const, content: "Hallo" },
        { role: "assistant" as const, content: "Guten Tag." },
      ],
      systemPrompt: () => null,
      state: () => state,
      recordedId: () => null,
      continueRecording: vi.fn(),
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { controller, bundles } = experimentController(history);
      await controller.resume(42);
      const restored = bundles.at(-1)!;
      // Kept whatever its new session id draws, and restored as its state, not told as a change.
      expect(variantOf(restored.runtime)).toBe("formal");
      expect(restored.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    }
  });

  it("are none on a host without an agent registry, which knows no declarations", () => {
    const runtime = createInsuranceDemoRuntime();
    new ConnectionController(() => undefined, { runtime, session: new AgentSession(runtime, idleLlm) });
    expect(variantOf(runtime)).toBeUndefined();
  });
});
