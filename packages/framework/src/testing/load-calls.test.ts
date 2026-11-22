import { describe, expect, it } from "vitest";
import { record, ran, turn } from "../test-fixtures/conversations.js";
import { callsIn } from "./load-calls.js";

const spoken = (text: string) => callsIn("call.md", text)!.calls[0]!.turns.map((entry) => [entry.turn, entry.caller, entry.reply]);

describe("the calls curb review reads", () => {
  it("reads every conversation of a saved test run, with its tools, tool calls and ending", () => {
    const booked = record([turn({ turn: 1, caller: "Book it.", reply: "Done.", toolCalls: [ran("book_appointment")] })], {
      tools: [{ name: "book_appointment", description: "Book an appointment." }],
      ending: { by: "agent" },
    });
    const second = { ...record([turn({ turn: 1 })]), scenario: { ...booked.scenario, run: 2 } };
    const run = { format: "curb.test-run", version: 1, id: "r1", scenarios: [], conversations: [booked, second] };

    const read = callsIn("anything.txt", JSON.stringify(run, null, 2));

    expect(read?.skipped).toBe(0);
    expect(read?.calls.map((call) => [call.id, call.endedBy, call.recordsTools])).toEqual([
      ["books run 1", "agent", true],
      ["books run 2", "caller", true],
    ]);
    expect(read?.calls[0]).toMatchObject({ turns: booked.turns, tools: booked.tools });
    expect(read?.calls[1]).not.toHaveProperty("tools");
  });

  it("reads a Calls export line by line: who ended each call, no tool calls, and a call without a transcript left out", () => {
    const line = (callId: string, endReason: string, turns: Array<[string, string]> | null) =>
      JSON.stringify({
        callId,
        startedAt: "2030-03-04T09:00:00.000Z",
        endReason,
        durationMs: 42_000,
        transcript: turns && { turns: turns.map(([speaker, text]) => ({ speaker, text })) },
      });
    const text = [
      line("call-a", "agent_completed", [["agent", "Birch Street Studio."], ["caller", "A haircut on Tuesday, please."], ["agent", "You are booked."], ["agent", "Goodbye!"]]),
      line("call-b", "caller_hangup", [["caller", "Hello?"], ["caller", "Anyone there?"], ["agent", "Yes, hello."], ["caller", "Never mind."]]),
      line("call-c", "client_disconnect", [["caller", "Hi."], ["agent", "Hello."]]),
      line("call-d", "transfer", [["caller", "A person, please."], ["agent", "I will put you through."]]),
      line("call-e", "caller_ended", null),
      line("call-f", "caller_ended", []),
      "",
    ].join("\n");

    const read = callsIn("export.jsonl", text);

    expect(read?.skipped).toBe(2);
    expect(read?.calls.map((call) => [call.id, call.endedBy, call.recordsTools, call.tools])).toEqual([
      ["call-a", "agent", false, undefined],
      ["call-b", "caller", false, undefined],
      ["call-c", "caller", false, undefined],
      ["call-d", null, false, undefined],
    ]);
    // The agent's opening is turn 0, and what it says until the caller speaks again is one reply.
    expect(read?.calls[0]?.turns.map((entry) => [entry.turn, entry.caller, entry.reply])).toEqual([
      [0, null, "Birch Street Studio."],
      [1, "A haircut on Tuesday, please.", "You are booked. Goodbye!"],
    ]);
    // A caller who speaks twice before the agent answers is one turn; the last line got no reply.
    expect(read?.calls[1]?.turns.map((entry) => [entry.turn, entry.caller, entry.reply])).toEqual([
      [1, "Hello? Anyone there?", "Yes, hello."],
      [2, "Never mind.", ""],
    ]);
    // A single line is an export too, and a speaker may go by another of the names a transcript uses.
    const one = { callId: "call-g", endReason: "caller_ended", transcript: { turns: [{ speaker: "User", text: "Hi." }, { speaker: "assistant", text: "Hello." }, { speaker: "system", text: "(silence)" }] } };
    expect(callsIn("one.json", JSON.stringify(one))?.calls[0]?.turns.map((entry) => [entry.caller, entry.reply])).toEqual([["Hi.", "Hello."]]);
    // A line that holds no transcript at all is a call without one.
    expect(callsIn("bare.jsonl", `${JSON.stringify(one)}\n${JSON.stringify({ callId: "call-h" })}\n`)).toMatchObject({ calls: [{ id: "call-g" }], skipped: 1 });
  });

  it("reads a Calls export line's tool calls into the agent turn each happened in, by its time in the call", () => {
    const said = (speaker: string, text: string, startOffsetMs: number) => ({ speaker, text, startOffsetMs, endOffsetMs: startOffsetMs + 900 });
    const line = {
      callId: "call-t",
      startedAt: "2030-03-04T09:00:00+01:00",
      endReason: "error",
      caller: "+15550100",
      transcript: {
        final: true,
        complete: true,
        turns: [
          said("agent", "Birch Street Studio.", 0),
          said("caller", "Is Saturday free?", 2_000),
          said("agent", "Saturday at ten is free.", 4_000),
          said("caller", "Book it, please.", 6_000),
          said("agent", "You are booked.", 9_000),
          said("caller", "Thanks, bye.", 11_000),
          said("agent", "Goodbye!", 12_500),
        ],
      },
      // Out of order on purpose: the time in the call places each one.
      toolCalls: [
        { name: "book_appointment", offsetMs: 7_500, outcome: "failed", arguments: { day: "saturday" }, error: "slot taken" },
        { name: "lookup_slots", offsetMs: 3_100, outcome: "ok", input: { day: "saturday" }, result: { slots: ["10:00"] } },
        { name: "book_appointment", offsetMs: 8_200, ok: true, arguments: { day: "saturday", time: "10:00" }, result: { ok: true, message: "booked" } },
        // At the same time as the agent's words, the tool call comes first.
        { name: "end_call", offsetMs: 12_500, outcome: "succeeded" },
        { offsetMs: 13_000, outcome: "ok" },
      ],
    };

    const call = callsIn("export.jsonl", `${JSON.stringify(line)}\n`)!.calls[0]!;

    // The end reason does not say who ended it; the end_call that ran does.
    expect(call).toMatchObject({ id: "call-t", recordsTools: true, endedBy: "agent" });
    expect(call.turns.map((turn) => [turn.turn, turn.caller, turn.reply, turn.toolCalls.map((toolCall) => toolCall.name), turn.endedCall])).toEqual([
      [0, null, "Birch Street Studio.", [], false],
      [1, "Is Saturday free?", "Saturday at ten is free.", ["lookup_slots"], false],
      [2, "Book it, please.", "You are booked.", ["book_appointment", "book_appointment"], false],
      [3, "Thanks, bye.", "Goodbye!", ["end_call"], true],
    ]);
    expect(call.turns[1]!.toolCalls).toEqual([{ name: "lookup_slots", input: { day: "saturday" }, ok: true, result: { ok: true, data: { slots: ["10:00"] } } }]);
    expect(call.turns[2]!.toolCalls).toEqual([
      { name: "book_appointment", input: { day: "saturday" }, ok: false, result: { ok: false, message: "slot taken" } },
      { name: "book_appointment", input: { day: "saturday", time: "10:00" }, ok: true, result: { ok: true, message: "booked" } },
    ]);
    expect(call.turns[3]!.toolCalls).toEqual([{ name: "end_call", input: {}, ok: true, result: null }]);

    // An empty list says the call recorded its tool calls and made none.
    const none = callsIn("none.jsonl", JSON.stringify({ ...line, toolCalls: [] }))!.calls[0]!;
    expect(none).toMatchObject({ recordsTools: true, endedBy: null });
    expect(none.turns.flatMap((turn) => turn.toolCalls)).toEqual([]);
    // Without the field the line reads as before: no tool calls, and not recorded.
    const { toolCalls: _dropped, ...older } = line;
    const before = callsIn("older.jsonl", JSON.stringify(older))!.calls[0]!;
    expect(before).toMatchObject({ recordsTools: false, endedBy: null });
    expect(before.turns.map((turn) => [turn.caller, turn.reply])).toEqual(none.turns.map((turn) => [turn.caller, turn.reply]));
  });

  it("places a Calls export's tool call before any words, and one without a time where the one before it was", () => {
    const line = {
      callId: "call-u",
      endReason: "caller_ended",
      transcript: { turns: [{ speaker: "agent", text: "Hello, Anna.", startOffsetMs: 1_000 }, { speaker: "caller", text: "Hi.", startOffsetMs: 3_000 }, { speaker: "agent", text: "Your order shipped.", startOffsetMs: 5_000 }] },
      toolCalls: [
        { name: "lookup_caller", offsetMs: 200, outcome: "ok" },
        { name: "lookup_order", offsetMs: 4_000, outcome: "ok" },
        { name: "track_parcel", outcome: "ok" },
      ],
    };

    const call = callsIn("export.jsonl", JSON.stringify(line))!.calls[0]!;

    expect(call.turns.map((turn) => [turn.caller, turn.reply, turn.toolCalls.map((toolCall) => toolCall.name)])).toEqual([
      [null, "Hello, Anna.", ["lookup_caller"]],
      ["Hi.", "Your order shipped.", ["lookup_order", "track_parcel"]],
    ]);
    expect(call.endedBy).toBe("caller");
  });

  it("reads the output of curb conversations --json, with each tool call and its result", () => {
    const message = (role: string, content: string, more: Record<string, unknown> = {}) => ({ seq: 0, role, content, tool_calls: null, tool_name: null, tool_result: null, created_at: "2030-03-04T09:00:00.000Z", ...more });
    const conversations = [
      {
        id: 7,
        agentId: "agent",
        startedAt: "2030-03-04T09:00:00.000Z",
        messages: [
          message("user", "Is the studio open on Saturday?"),
          message("assistant", "", { tool_calls: JSON.stringify([{ id: "c1", name: "lookup_hours", input: { day: "saturday" } }, { id: "c2", name: "lookup_hours", input: { day: "sunday" } }]) }),
          message("tool", "", { tool_name: "lookup_hours", tool_result: JSON.stringify({ ok: true, message: "9 to 13" }) }),
          message("tool", "", { tool_name: "lookup_hours", tool_result: JSON.stringify({ ok: false, message: "no hours for sunday" }) }),
          message("assistant", "Saturday from nine to one."),
          message("user", "Thanks, bye."),
          message("assistant", "Goodbye.", { tool_calls: JSON.stringify([{ id: "c3", name: "end_call", input: {} }]) }),
          message("tool", "", { tool_name: "end_call", tool_result: JSON.stringify({ ok: true }) }),
        ],
      },
      { id: 8, agentId: "agent", startedAt: "2030-03-04T10:00:00.000Z", messages: [message("user", "Hello"), message("assistant", "Hi.")] },
      { id: 9, agentId: "agent", startedAt: "2030-03-04T11:00:00.000Z", messages: [] },
    ];

    const read = callsIn("dev.json", JSON.stringify({ conversations }));

    expect(read?.skipped).toBe(1);
    // The agent ended the first call; of the second the store does not say how it stopped.
    expect(read?.calls.map((call) => [call.id, call.endedBy, call.recordsTools])).toEqual([
      ["conversation 7", "agent", true],
      ["conversation 8", null, true],
    ]);
    const [first, last] = read!.calls[0]!.turns;
    expect(first).toMatchObject({
      turn: 1,
      caller: "Is the studio open on Saturday?",
      reply: "Saturday from nine to one.",
      endedCall: false,
      toolCalls: [
        { name: "lookup_hours", input: { day: "saturday" }, ok: true, result: { ok: true, message: "9 to 13" } },
        { name: "lookup_hours", input: { day: "sunday" }, ok: false, result: { ok: false, message: "no hours for sunday" } },
      ],
    });
    expect(last).toMatchObject({ turn: 2, caller: "Thanks, bye.", reply: "Goodbye.", endedCall: true });
  });

  it("reads one call from text or Markdown by its speaker labels", () => {
    expect(
      spoken(
        [
          "# Call of 4 March",
          "",
          "**Agent:** Birch Street Studio, this is Lena.",
          "**Customer**: I'd like to move my appointment.",
          "It is on Tuesday.",
          "",
          "assistant: To which day?",
          "USER: Friday.",
          "__Bot:__ Friday at ten is free.",
        ].join("\n"),
      ),
    ).toEqual([
      [0, null, "Birch Street Studio, this is Lena."],
      [1, "I'd like to move my appointment. It is on Tuesday.", "To which day?"],
      [2, "Friday.", "Friday at ten is free."],
    ]);
    const call = callsIn("moved.txt", "Caller: Hi.\r\nAgent: Hello.")!.calls[0]!;
    expect(call).toMatchObject({ id: "moved.txt", endedBy: null, recordsTools: false });
  });

  it("recognises none of the shapes in anything else", () => {
    // A note with one speaker is no call, and neither is JSON of another kind.
    expect(callsIn("notes.md", "# Notes\n\nAgent: the thing we build.\n")).toBeNull();
    expect(callsIn("package.json", JSON.stringify({ name: "project", version: "1.0.0" }, null, 2))).toBeNull();
    expect(callsIn("list.json", JSON.stringify([{ callId: "a", transcript: null }]))).toBeNull();
    expect(callsIn("mixed.jsonl", `${JSON.stringify({ callId: "a", transcript: null })}\n{"other":1}\n`)).toBeNull();
    expect(callsIn("run.json", JSON.stringify({ format: "curb.test-run", conversations: [{ scenario: {} }] }))).toBeNull();
    expect(callsIn("empty.txt", "")).toBeNull();
  });
});
