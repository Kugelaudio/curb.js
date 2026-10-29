import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppMessages } from "../messages.js";
import { kugelaudio } from "../providers.js";
import { SessionSettings } from "../session-settings.js";
import type { AgentSessionBundle } from "../server/connection.js";
import type { VoiceSessionHandle } from "../server/voice/orchestration.js";
import { JOB_LINK_ENV, linkRegistrar, localRegistrar, registrarFromEnv, startJobLink, type JobLink } from "./call-link.js";
import { EventJournal, type JournalEntry } from "./event-journal.js";
import { serveCall, type ServedCall } from "./serve-call.js";
import { SessionRegistry } from "./session-registry.js";

/**
 * Worker mode: LiveKit runs each job in its own process, so a call registers with the
 * management process over the job link. Both ends run in this process here, over a real
 * local socket, with `serveCall` on the job side exactly as the project's worker.ts uses it.
 */

let link: JobLink | null = null;
afterEach(async () => {
  await link?.close();
  link = null;
});

/** One job's call: a runtime's messages and settings, and a voice session that runs until closed. */
function job(adjustable: { host?: Array<"tts.voice"> } = { host: ["tts.voice"] }) {
  const settings = new SessionSettings();
  settings.setAdjustable(adjustable);
  settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
  const messages = new AppMessages({ warn: () => {}, error: () => {} });
  const bundle = { runtime: { messages, settings }, session: {} } as unknown as AgentSessionBundle;
  let served!: ServedCall;
  const closes: Array<number | undefined> = [];
  const start = async (call: ServedCall): Promise<VoiceSessionHandle> => {
    served = call;
    return {
      close: async (options) => {
        closes.push(options?.graceMs);
        served.onClosed();
      },
      clips: {} as VoiceSessionHandle["clips"],
      sendText: async () => {},
      setBundle: () => {},
      interrupt: () => {},
    };
  };
  return { settings, messages, bundle, start, closes, served: () => served };
}

function records(journal: EventJournal): JournalEntry[] {
  const seen: JournalEntry[] = [];
  journal.subscribe(0, (record) => void seen.push(record))();
  return seen;
}

describe("the job link (curb start)", () => {
  it("registers each job's call under its room name and removes it when the job's call ends", async () => {
    const journal = new EventJournal();
    const registry = new SessionRegistry({ journal, log: () => {} });
    link = await startJobLink(registry, { log: () => {} });

    const a = job();
    const b = job();
    const handleA = await serveCall({ sessionId: "room-a", bundle: a.bundle, registrar: linkRegistrar(link.path) }, a.start);
    await serveCall({ sessionId: "room-b", bundle: b.bundle, registrar: linkRegistrar(link.path) }, b.start);
    await vi.waitFor(() => expect(registry.list().map((call) => [call.sessionId, call.state])).toEqual([
      ["room-a", "connected"],
      ["room-b", "connected"],
    ]));

    // The job's records reach the parent's journal under the call's own producer and sequence.
    a.served().reporter?.turn({ speaker: "caller", text: "hello", final: true });
    a.messages.send.toHost("lead", { score: 0.9 });
    await vi.waitFor(() => expect(records(journal).filter((record) => record.producer === "room-a")).toHaveLength(2));
    const [turn, host] = records(journal).filter((record) => record.producer === "room-a");
    expect(turn).toMatchObject({ class: "conversation", seq: 1, body: { type: "turn", text: "hello" } });
    expect(host).toMatchObject({ class: "host", seq: 2, body: { name: "lead", payload: { score: 0.9 } } });

    // The job's call ends: it leaves the registry, and the terminal record is written.
    await handleA.close();
    await vi.waitFor(() => expect(registry.list().map((call) => call.sessionId)).toEqual(["room-b"]));
    expect(records(journal).at(-1)).toMatchObject({ producer: "room-a", body: { kind: "curb.ended", payload: { reason: "completed" } } });
  });

  it("carries host messages, settings changes and stops to the job, refusals included", async () => {
    const registry = new SessionRegistry({ log: () => {} });
    link = await startJobLink(registry, { log: () => {} });
    const a = job();
    const heard: unknown[] = [];
    a.messages.subscribe("host", "note", { schema: z.object({ text: z.string() }), onMessage: (payload) => void heard.push(payload) });
    await serveCall({ sessionId: "room-a", bundle: a.bundle, registrar: linkRegistrar(link.path) }, a.start);
    await vi.waitFor(() => expect(registry.get("room-a")?.state).toBe("connected"));

    expect(await registry.deliver("room-a", { id: "m1", name: "note", payload: { text: "hi" } })).toEqual({ ok: true, delivered: true });
    expect(heard).toEqual([{ text: "hi" }]);
    expect(await registry.deliver("room-a", { id: "m2", name: "note", payload: { text: 1 } })).toMatchObject({
      ok: false,
      code: "invalid_payload",
      issues: [{ path: ["text"] }],
    });
    expect(await registry.deliver("room-a", { id: "m3", name: "nobody", payload: {} })).toMatchObject({ ok: false, code: "no_handler" });

    expect(await registry.update("room-a", { tts: { voice: 7 } })).toMatchObject({ ok: true, settings: { tts: { voice: 7 } } });
    expect(a.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 7 }));
    expect(await registry.update("room-a", { llm: { provider: "anthropic", model: "m" } })).toMatchObject({
      ok: false,
      code: "not_adjustable",
      path: "llm",
    });

    expect(await registry.stop("room-a", "host_stop", 2000)).toBe(true);
    expect(a.closes).toEqual([2000]);
    expect(registry.list()).toEqual([]);
  });

  it("ends the call's registration when the job process goes away", async () => {
    const registry = new SessionRegistry({ log: () => {} });
    link = await startJobLink(registry, { log: () => {} });
    const a = job();
    await serveCall({ sessionId: "room-a", bundle: a.bundle, registrar: linkRegistrar(link.path) }, a.start);
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    await link.close(); // every job socket is cut, as when the job process dies
    link = null;
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
  });

  it("runs a call unregistered when its room is already registered, and says so", async () => {
    const registry = new SessionRegistry({ log: () => {} });
    link = await startJobLink(registry, { log: () => {} });
    const a = job();
    const b = job();
    await serveCall({ sessionId: "room-a", bundle: a.bundle, registrar: linkRegistrar(link.path) }, a.start);
    const log = vi.fn();
    const handle = await serveCall({ sessionId: "room-a", bundle: b.bundle, registrar: linkRegistrar(link.path), log }, b.start);
    expect(handle).toBeDefined();
    expect(log.mock.calls[0]?.[0]).toMatch(/runs without the management port: .*already registered/);
  });

  it("is found through the environment the worker sets for its jobs", () => {
    expect(registrarFromEnv({})).toBeNull();
    expect(registrarFromEnv({ [JOB_LINK_ENV]: "/tmp/x.sock" })).not.toBeNull();
  });
});

describe("serveCall in one process (curb dev)", () => {
  it("connects toHost to the call's records and frees the call when the session closes", async () => {
    const journal = new EventJournal();
    const registry = new SessionRegistry({ journal, log: () => {} });
    const a = job();
    const handle = await serveCall({ sessionId: "curb-1", bundle: a.bundle, registrar: localRegistrar(registry) }, a.start);
    expect(registry.get("curb-1")?.state).toBe("connected");
    a.messages.send.toHost("lead", {});
    expect(records(journal).at(-1)).toMatchObject({ producer: "curb-1", class: "host" });
    await handle.close();
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
    // After the call, nothing carries host messages any more.
    await expect(a.messages.send.askHost("late")).rejects.toThrow(/no host/);
  });

  it("puts what the agent sent the client, and what it could not deliver, in the call record", async () => {
    const journal = new EventJournal();
    const registry = new SessionRegistry({ journal, log: () => {} });
    const a = job();
    let reach: "sent" | "phone_call" = "sent";
    a.messages.connectClient(() => reach);
    a.messages.subscribe("client", "quote", { onMessage: () => ({ price: 12 }) });
    const handle = await serveCall({ sessionId: "curb-1", bundle: a.bundle, registrar: localRegistrar(registry) }, a.start);

    a.messages.send.toClient("show-form", { form: "claim" });
    a.messages.recordReplyToClient("quote", "q-1", { price: 12 });
    reach = "phone_call";
    a.messages.send.toClient("show-form", { form: "again" });
    await handle.close();
    await vi.waitFor(() => expect(registry.list()).toEqual([]));

    const kinds = records(journal).map((record) => [(record.body as { kind?: string }).kind, (record.body as { payload?: unknown }).payload]);
    expect(kinds).toEqual([
      ["curb.message_to_client", { key: "show-form", id: expect.any(String), payload: { form: "claim" } }],
      ["curb.reply_to_client", { key: "quote", id: "q-1", reply: { price: 12 } }],
      ["curb.messages", { undeliveredToClient: { "show-form": 1 }, refusedQueuedHostMessages: 0 }],
      ["curb.ended", { reason: "completed" }],
    ]);
  });

  it("carries the record of a worker job's client traffic over the job link", async () => {
    const journal = new EventJournal();
    const registry = new SessionRegistry({ journal, log: () => {} });
    link = await startJobLink(registry, { log: () => {} });
    const a = job();
    a.messages.connectClient(() => "no_client_yet");
    const handle = await serveCall({ sessionId: "room-a", bundle: a.bundle, registrar: linkRegistrar(link.path) }, a.start);
    a.messages.send.toClient("early");
    await handle.close();
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
    expect(records(journal).map((record) => (record.body as { kind?: string }).kind)).toEqual(["curb.messages", "curb.ended"]);
    expect(records(journal)[0]?.body).toMatchObject({ payload: { undeliveredToClient: { early: 1 } } });
  });

  it("only runs the session when there is no management port", async () => {
    const a = job();
    await serveCall({ sessionId: "curb-1", bundle: a.bundle, registrar: null }, a.start);
    expect(a.served().reporter).toBeUndefined();
    await expect(a.messages.send.askHost("x")).rejects.toThrow(/no host/);
  });

  it("frees the entry when the session fails to start", async () => {
    const registry = new SessionRegistry({ log: () => {} });
    const a = job();
    await expect(
      serveCall({ sessionId: "curb-1", bundle: a.bundle, registrar: localRegistrar(registry) }, async () => {
        throw new Error("no LiveKit");
      }),
    ).rejects.toThrow("no LiveKit");
    expect(registry.list()).toEqual([]);
  });
});
