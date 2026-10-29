import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotAgentStores } from "../agent-state.js";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { openingLineOf, type AgentFirstTurn } from "../config.js";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { createAgentRuntime, createAgentSession, getHostedAgent } from "../server/bootstrap.js";
import { AGENT_FIRST_TURN_PROMPT } from "../server/voice/livekit-host/call-opening.js";
import {
  APPOINTMENTS,
  LISA,
  bookingRuntime,
  booked,
  callsBook,
  readBackOf,
  says,
  scripted,
  type Booking,
} from "../test-fixtures/booking.js";
import { END_CALL_TOOL_NAME } from "../types.js";
import { END_CALL_VOICE_STYLE } from "../voice-style.js";
import {
  SAY_SESSION_PATH,
  formatSayResult,
  parseSayArgs,
  readSaySession,
  runSayTurn,
  sayCommand,
  type SayBundle,
  type SayHost,
} from "./say.js";

const SPOKEN_RULES = "## Spoken-reply rules (test)";

/** A scripted LLM: each request takes the next response, and every request is kept. */
function scriptedLlm(responses: Array<AgentRunResponse | Error>) {
  const requests: AgentRunRequest[] = [];
  const llm: AgentLlmClient = async (request) => {
    requests.push(request);
    const next = responses.shift() ?? { text: "(script ended)", toolCalls: [] };
    if (next instanceof Error) throw next;
    return next;
  };
  return { llm, requests };
}

/** The fixture project's agent (AGENT_PROJECT_DIR in vitest.config.ts) on a scripted LLM. */
function fixtureHost(llm: AgentLlmClient, built: SayBundle[] = []): SayHost {
  return {
    async createBundle() {
      const bundle = await createAgentSession(llm, undefined, undefined, { spokenStyleSuffix: SPOKEN_RULES });
      built.push(bundle);
      return bundle;
    },
    skillPaths: async (agentId) => (await getHostedAgent(agentId)).routes.map((route) => route.path),
  };
}

/** The fixture agent as if it spoke first: `firstTurn` on its bundle, and on its session as
 * `createAgentSession` puts a `{ say }` line there. */
function openingHost(llm: AgentLlmClient, firstTurn: AgentFirstTurn, built: SayBundle[] = []): SayHost {
  return {
    async createBundle() {
      const { runtime, agentId } = await createAgentRuntime();
      const session = new AgentSession(runtime, llm, {
        spokenStyleSuffix: SPOKEN_RULES,
        opening: openingLineOf(firstTurn),
      });
      const bundle = { runtime, session, agentId, firstTurn };
      built.push(bundle);
      return bundle;
    },
    skillPaths: async (agentId) => (await getHostedAgent(agentId)).routes.map((route) => route.path),
  };
}

/** The booking agent (`test-fixtures/booking.tsx`, `book_meeting` asks the caller first), as a
 * new process builds it for every curb say: a fresh runtime and session on the saved conversation. */
function bookingHost(llm: AgentLlmClient) {
  const onSubmit = vi.fn(async (input: Booking) => booked(input));
  const host: SayHost = {
    async createBundle() {
      const { runtime } = bookingRuntime(onSubmit);
      return { runtime, session: new AgentSession(runtime, llm), agentId: "appointments" };
    },
    skillPaths: async () => [APPOINTMENTS],
  };
  return { host, onSubmit };
}

const BOOK_LINE = "Tuesday 15:00, lisa@example.com.";

const LINE = "Ich bin Clara, die digitale Assistentin von Beispiel GmbH.";

function lastUserMessage(request: AgentRunRequest): string | undefined {
  return request.messages.filter((message) => message.role === "user").at(-1)?.content;
}

describe("curb say", () => {
  let projectRoot: string;
  let out: string[];
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "curb-say-"));
    out = [];
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));
  const write = (text: string) => void out.push(text);
  const statePath = () => join(projectRoot, SAY_SESSION_PATH);

  it("runs a spoken turn and continues the conversation in the next invocation", async () => {
    const first = scriptedLlm([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/claim-procedure" } }] },
      {
        text: "",
        toolCalls: [
          { name: "complete_claim_procedure_stage", input: {} },
          { name: "complete_claim_procedure_stage", input: {} },
          { name: "complete_claim_procedure_stage", input: {} },
        ],
      },
      { text: "Your claim is ready to submit.", toolCalls: [] },
    ]);
    const code = await sayCommand(["--json", "I", "want to report a claim"], projectRoot, {
      host: fixtureHost(first.llm),
      out: write,
    });

    expect(code).toBe(0);
    const result = JSON.parse(out[0]);
    expect(result).toMatchObject({
      reply: "Your claim is ready to submit.",
      errors: [],
      skillPath: "/claim-procedure",
      turn: 1,
    });
    expect(result.toolCalls.map((call: { name: string; ok: boolean }) => [call.name, call.ok])).toEqual([
      ["read_skill", true],
      ["complete_claim_procedure_stage", true],
      ["complete_claim_procedure_stage", true],
      ["complete_claim_procedure_stage", true],
    ]);
    expect(result.toolCalls[3].result).toEqual({ ok: true, message: "Procedure is complete." });
    expect(result.contextDiff.join("\n")).toContain("Submit the prepared claim");
    // A call's semantics: the voice rules ride along, and the hang-up tool with its rules.
    expect(first.requests[0].systemPrompt).toContain(SPOKEN_RULES);
    expect(first.requests[0].systemPrompt).toContain(END_CALL_VOICE_STYLE[0]);
    expect(first.requests[0].tools.map((tool) => tool.name)).toContain(END_CALL_TOOL_NAME);
    expect(result).toMatchObject({ opening: null, endedCall: false });
    expect(lastUserMessage(first.requests[0])).toBe("I want to report a claim");

    const saved = readSaySession(statePath())!;
    expect(saved).toMatchObject({ agentId: "agent", turns: 1, loadedSkills: ["/claim-procedure"] });
    expect(saved.stores.insurance.values).toEqual({ procedureComplete: true });

    // A new process: a fresh session, the saved conversation restored onto it.
    const second = scriptedLlm([{ text: "Glad I could help.", toolCalls: [] }]);
    const built: SayBundle[] = [];
    out = [];
    expect(await sayCommand(["Thanks!"], projectRoot, { host: fixtureHost(second.llm, built), out: write })).toBe(0);

    const request = second.requests[0];
    const said = request.messages.map((message) => [message.role, message.content]);
    expect(said).toContainEqual(["user", "I want to report a claim"]);
    expect(said).toContainEqual(["assistant", "Your claim is ready to submit."]);
    expect(lastUserMessage(request)).toBe("Thanks!");
    expect(request.skillTitle).toBe("Claim procedure");
    expect(snapshotAgentStores(built[0].runtime).stores.insurance.values).toEqual({ procedureComplete: true });
    expect(out.join("")).toBe("Glad I could help.\n[turn 2, skill /claim-procedure]\n");
    expect(readSaySession(statePath())!.turns).toBe(2);
  });

  it("continues a conversation saved before the agent level, without the skills that are none now", async () => {
    // Kept data: "/", where conversations started before the agent level, and a skill
    // deleted since.
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        agentId: "agent",
        turns: 1,
        messages: [
          { role: "user", content: "I want to report a claim" },
          { role: "assistant", content: "Let us start with the procedure." },
        ],
        loadedSkills: ["/", "/claim-procedure", "/gone"],
        stores: {},
      }),
    );
    const llm = scriptedLlm([{ text: "Is everyone safe?", toolCalls: [] }]);
    const built: SayBundle[] = [];

    const { result, notes } = await runSayTurn({
      text: "Yes, go on.",
      statePath: statePath(),
      fresh: false,
      host: fixtureHost(llm.llm, built),
    });

    expect(result).toMatchObject({ reply: "Is everyone safe?", errors: [], skillPath: "/claim-procedure", turn: 2 });
    expect(built[0].runtime.snapshot().context.loadedSkills.map((skill) => skill.path)).toEqual(["/claim-procedure"]);
    // "/" was the home skill; its content is the agent's own now, so only /gone is named.
    expect(notes).toContain("Skill(s) /gone no longer exist and were not reloaded.");
    expect(readSaySession(statePath())!.loadedSkills).toEqual(["/claim-procedure"]);
  });

  it("starts over with --new, and --new alone resets", async () => {
    const llm = scriptedLlm([
      { text: "Hello.", toolCalls: [] },
      { text: "Hello again.", toolCalls: [] },
    ]);
    await sayCommand(["Hi"], projectRoot, { host: fixtureHost(llm.llm), out: write });
    await sayCommand(["--new", "Hi there"], projectRoot, { host: fixtureHost(llm.llm), out: write });

    expect(llm.requests[1].messages.filter((message) => message.role !== "tool").map((m) => m.content)).toEqual([
      "Hi there",
    ]);
    expect(readSaySession(statePath())!.turns).toBe(1);

    expect(await sayCommand(["--new"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(0);
    expect(existsSync(statePath())).toBe(false);
  });

  it("exits 1 on a failed turn and keeps it out of the conversation", async () => {
    const llm = scriptedLlm([{ text: "Hello.", toolCalls: [] }, new Error("ANTHROPIC_API_KEY is required")]);
    await sayCommand(["Hi"], projectRoot, { host: fixtureHost(llm.llm), out: write });
    const before = readFileSync(statePath(), "utf8");
    out = [];

    expect(await sayCommand(["--json", "Are you there?"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(1);
    expect(JSON.parse(out[0]).errors).toEqual([{ kind: "failed", message: "ANTHROPIC_API_KEY is required" }]);
    expect(readFileSync(statePath(), "utf8")).toBe(before);
  });

  it("saves a failed turn that already ran a tool, so running it again does not run the tool twice", async () => {
    const callback = { name: "Max Muster", phone: "+49 30 1234", topic: "my claim" };
    const llm = scriptedLlm([
      { text: "", toolCalls: [{ id: "t1", name: "request_callback", input: callback }] },
      new Error("provider down"),
    ]);

    expect(await sayCommand(["--json", "Call me back"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(1);
    expect(JSON.parse(out[0]).errors).toEqual([{ kind: "failed", message: "provider down" }]);
    const saved = readSaySession(statePath())!;
    expect(saved.turns).toBe(1);
    expect(saved.messages.flatMap((message) => (message.role === "assistant" ? message.toolCalls ?? [] : []))).toEqual([
      expect.objectContaining({ id: "t1", name: "request_callback", input: callback }),
    ]);
  });

  it("keeps a turn that failed before any tool ran out of the conversation", async () => {
    const llm = scriptedLlm([
      { text: "", toolCalls: [{ id: "t1", name: "file_claim_now", input: {} }] },
      new Error("provider down"),
    ]);

    expect(await sayCommand(["File it"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(1);
    expect(existsSync(statePath())).toBe(false);
  });

  it("exits 1 when the turn runs out of steps on a refused tool", async () => {
    // However many steps the agent allows, every one of them calls a tool that does not exist.
    const refusing: AgentLlmClient = async () => ({
      text: "",
      toolCalls: [{ name: "file_claim_now", input: { policy: "x" } }],
    });

    expect(await sayCommand(["File it"], projectRoot, { host: fixtureHost(refusing), out: write })).toBe(1);
    const printed = out.join("");
    expect(printed).toContain('[tool file_claim_now refused] {"policy":"x"} -> Unknown tool "file_claim_now"');
    expect(printed).toContain("[error step_limit]");
    expect(printed).toContain("Look first for a tool the model keeps calling");
  });

  it("prints usage and exits 1 without words", async () => {
    expect(await sayCommand([], projectRoot, { host: fixtureHost(scriptedLlm([]).llm), out: write })).toBe(1);
    expect(() => parseSayArgs(["--loud", "hi"])).toThrow("curb say: unknown option --loud.");
    expect(parseSayArgs(["--json", "hello", "there", "--new"])).toEqual({
      text: "hello there",
      fresh: true,
      json: true,
      client: {},
      fakes: {},
    });
  });

  it("--fake takes a tool, with the default result or a JSON one, and refuses what cannot be a fake", () => {
    expect(parseSayArgs(["--fake", "create_claim", "--fake", 'send_sms={"ok":false,"message":"No signal."}', "Ja"])).toMatchObject({
      text: "Ja",
      fakes: { create_claim: { ok: true, message: "Done." }, send_sms: { ok: false, message: "No signal." } },
    });
    expect(() => parseSayArgs(["--fake"])).toThrow("curb say: --fake takes the tool to fake, e.g. --fake create_claim");
    expect(() => parseSayArgs(["--fake", "--json", "Ja"])).toThrow("curb say: --fake takes the tool to fake");
    expect(() => parseSayArgs(["--fake", "read_skill", "Ja"])).toThrow(
      "curb say: --fake read_skill: read_skill is the framework's own tool, not one of the agent's, and cannot be faked.",
    );
    expect(() => parseSayArgs(["--fake", "create_claim={ok:true}", "Ja"])).toThrow(
      "curb say: --fake create_claim={ok:true}: the result is not JSON (",
    );
    expect(() => parseSayArgs(["--fake", 'create_claim={"ok":"yes"}', "Ja"])).toThrow(
      'curb say: --fake create_claim={"ok":"yes"}: ok must be true or false; got "yes".',
    );
  });

  it("--fake: a held tool still waits for the yes, which runs the fake, kept from the turn that gave it; --new drops it", async () => {
    const { llm } = scripted([callsBook(LISA), says("Done, see you on Tuesday."), says("Hello.")], ["yes"]);
    const { host, onSubmit } = bookingHost(llm);

    expect(await sayCommand(["--fake", "book_meeting", BOOK_LINE], projectRoot, { host, out: write })).toBe(0);
    expect(out.join("")).toContain("[tool book_meeting held]");
    expect(readSaySession(statePath())!.fakes).toEqual({ book_meeting: { ok: true, message: "Done." } });

    out = [];
    expect(await sayCommand(["Ja, genau."], projectRoot, { host, out: write })).toBe(0);
    expect(onSubmit).not.toHaveBeenCalled();
    // The tool's own feedback follows the fake's result, as it follows onSubmit's on a real call.
    expect(out.join("")).toBe(
      [
        "Done, see you on Tuesday.",
        '[confirmation yes] "Ja, genau.": book_meeting ran',
        `[tool book_meeting faked] ${JSON.stringify(LISA)}`,
        "[context added]",
        "+ content: Done.",
        "[turn 2, skill /appointments]",
      ].join("\n") + "\n",
    );

    expect(await sayCommand(["--new", "Hi"], projectRoot, { host, out: write })).toBe(0);
    expect(readSaySession(statePath())!.fakes).toBeUndefined();
  });

  it("prints how the caller's words answered the held action: no and unclear run nothing", async () => {
    for (const [verdict, answer, line] of [
      ["no", "Ja, passt so. Wie lautet meine Buchungsnummer?", "book_meeting did not run"],
      ["unclear", "Hm?", "book_meeting still waits for the caller's yes"],
    ] as const) {
      const { llm } = scripted([callsBook(LISA), says("Which day suits you?")], [verdict]);
      const { host, onSubmit } = bookingHost(llm);
      await sayCommand(["--new", BOOK_LINE], projectRoot, { host, out: write });

      out = [];
      expect(await sayCommand(["--json", answer], projectRoot, { host, out: write })).toBe(0);
      expect(JSON.parse(out[0]).confirmation).toEqual({ tool: "book_meeting", readBack: readBackOf(LISA), answer, verdict, ran: false });
      expect(formatSayResult(JSON.parse(out[0])).split("\n").slice(0, 2)).toEqual([
        "Which day suits you?",
        `[confirmation ${verdict}] ${JSON.stringify(answer)}: ${line}`,
      ]);
      expect(onSubmit).not.toHaveBeenCalled();
    }
  });

  it("opens a new conversation with the agent's fixed line, with no model call, and only once", async () => {
    const llm = scriptedLlm([
      { text: "Gern, worum geht es?", toolCalls: [] },
      { text: "Das prüfe ich.", toolCalls: [] },
    ]);
    expect(
      await sayCommand(["--new", "Hallo"], projectRoot, { host: openingHost(llm.llm, { say: LINE }), out: write }),
    ).toBe(0);

    expect(out.join("")).toBe(`(opening) ${LINE}\nGern, worum geht es?\n[turn 1, no skill read]\n`);
    // One model call, the caller's: it sees its own opening first.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages.slice(0, 3).map((message) => [message.role, message.content])).toEqual([
      ["user", "(The conversation has just started.)"],
      ["assistant", LINE],
      ["user", "Hallo"],
    ]);

    out = [];
    expect(
      await sayCommand(["--json", "Meine Bestellung"], projectRoot, { host: openingHost(llm.llm, { say: LINE }), out: write }),
    ).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ opening: null, reply: "Das prüfe ich.", turn: 2 });
    const saved = readSaySession(statePath())!;
    expect(saved.messages.filter((message) => message.content === LINE)).toHaveLength(1);
  });

  it("opens with the model's greeting when the agent speaks first, as a call does", async () => {
    const llm = scriptedLlm([
      { text: "Guten Tag, hier ist die Schadenhotline.", toolCalls: [] },
      { text: "Was ist passiert?", toolCalls: [] },
    ]);
    expect(
      await sayCommand(["--json", "--new", "Ich habe einen Schaden"], projectRoot, {
        host: openingHost(llm.llm, "agent"),
        out: write,
      }),
    ).toBe(0);

    expect(JSON.parse(out[0])).toMatchObject({
      opening: { reply: "Guten Tag, hier ist die Schadenhotline.", toolCalls: [], errors: [] },
      reply: "Was ist passiert?",
      turn: 1,
    });
    expect(llm.requests[0].messages.at(-1)).toMatchObject({ role: "user", content: AGENT_FIRST_TURN_PROMPT, kind: "synthetic" });
    expect(lastUserMessage(llm.requests[1])).toBe("Ich habe einen Schaden");
  });

  it("reports an opening line that cannot be written, and keeps the turn out of the conversation", async () => {
    const llm = scriptedLlm([{ text: "Hallo.", toolCalls: [] }]);
    const host = openingHost(llm.llm, { say: (info) => info["client.event"] as string });

    expect(await sayCommand(["--new", "Hallo"], projectRoot, { host, out: write })).toBe(1);
    expect(out.join("")).toContain(
      "(opening) (no reply)\n(opening) [error failed] [AGENT_INVALID_AUTHORING_PROP] ERROR: " +
        "defineAgent({ firstTurn: { say } }) returned undefined instead of the opening line.",
    );
    expect(existsSync(statePath())).toBe(false);
  });

  it("hangs up like a call: end_call ends it, and only --new starts another", async () => {
    const llm = scriptedLlm([
      { text: "", toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Gern geschehen. Auf Wiederhören." } }] },
      { text: "Hallo, neues Gespräch.", toolCalls: [] },
    ]);

    expect(await sayCommand(["Danke, das war alles"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(0);
    expect(out.join("")).toBe("Gern geschehen. Auf Wiederhören.\n[the agent ended the call]\n[turn 1, no skill read]\n");
    expect(readSaySession(statePath())!.ended).toBe(true);

    await expect(sayCommand(["Hallo?"], projectRoot, { host: fixtureHost(llm.llm), out: write })).rejects.toThrow(
      'The call has ended: the agent hung up (end_call). Start a new one with curb say --new "<what the caller says>".',
    );
    out = [];
    expect(await sayCommand(["--json", "--new", "Hallo?"], projectRoot, { host: fixtureHost(llm.llm), out: write })).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ reply: "Hallo, neues Gespräch.", endedCall: false });
    expect(readSaySession(statePath())!.ended).toBeUndefined();
  });

  it("sets client.* page info with --client, keeps it for later turns, and --new resets it", async () => {
    const llm = scriptedLlm([]);
    const built: SayBundle[] = [];
    const host = () =>
      openingHost(llm.llm, { say: (info) => `Willkommen zum ${String(info["client.event"] ?? "Gespräch")}.` }, built);
    const info = (index: number) => built[index].runtime.info.snapshot();

    await sayCommand(["--client", "event=webinar-11-04", "--new", "Hallo"], projectRoot, { host: host(), out: write });
    expect(out[0].split("\n")[0]).toBe("(opening) Willkommen zum webinar-11-04.");
    expect(readSaySession(statePath())!.client).toEqual({ event: "webinar-11-04" });

    await sayCommand(["--client", "utm_source=newsletter", "Weiter"], projectRoot, { host: host(), out: write });
    expect(info(1)).toMatchObject({ "client.event": "webinar-11-04", "client.utm_source": "newsletter" });
    expect(readSaySession(statePath())!.client).toEqual({ event: "webinar-11-04", utm_source: "newsletter" });

    out = [];
    await sayCommand(["--new", "Hallo"], projectRoot, { host: host(), out: write });
    expect(out[0].split("\n")[0]).toBe("(opening) Willkommen zum Gespräch.");
    expect(info(2)["client.event"]).toBeUndefined();
    expect(readSaySession(statePath())!.client).toBeUndefined();
  });

  it("refuses --client entries outside the page info limits", () => {
    expect(parseSayArgs(["--client", "event=a=b", "hi"]).client).toEqual({ event: "a=b" });
    expect(() => parseSayArgs(["--client"])).toThrow("curb say: --client takes key=value, e.g. --client event=webinar-11-04.");
    expect(() => parseSayArgs(["--client", "event", "hi"])).toThrow("--client takes key=value");
    expect(() => parseSayArgs(["--client", "my-event=x", "hi"])).toThrow(
      'curb say: --client my-event=x: "my-event" cannot name page info (client.<key>)',
    );
    expect(() => parseSayArgs(["--client", `event=${"x".repeat(257)}`, "hi"])).toThrow(
      "client.event is 257 characters long; page info values hold at most 256.",
    );
  });
});

describe("say output", () => {
  it("prints a call held for the caller's yes as held, with its read-back", () => {
    const printed = formatSayResult({
      opening: null,
      endedCall: false,
      reply: "I'll book it for max@example.com, is that right?",
      confirmation: null,
      toolCalls: [
        {
          name: "book_meeting",
          input: { email: "max@example.com" },
          ok: false,
          result: { ok: false, message: "Held, not run: nothing has happened yet." },
          heldFor: "I'll book it for max@example.com, is that right?",
        },
      ],
      errors: [],
      contextDiff: [],
      skillPath: "/appointments",
      turn: 1,
    });
    expect(printed).toContain(
      `[tool book_meeting held] {"email":"max@example.com"} -> runs on the caller's yes to "I'll book it for max@example.com, is that right?"`,
    );
    expect(printed).not.toContain("refused");
  });

  it("caps the printed context diff and points at --json for the rest", () => {
    const printed = formatSayResult({
      opening: null,
      endedCall: false,
      reply: "",
      confirmation: null,
      toolCalls: [],
      errors: [],
      contextDiff: Array.from({ length: 35 }, (_, index) => `line ${index}`),
      skillPath: "",
      turn: 3,
    });
    expect(printed.split("\n")[0]).toBe("(no reply)");
    expect(printed).toContain("+ line 29\n+ ... 5 more line(s); curb say --json has all of them");
    // No skill read yet: the conversation is at the agent level.
    expect(printed.endsWith("[turn 3, no skill read]")).toBe(true);
  });
});
