import { describe, expect, it, vi } from "vitest";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";
import { AgentSiteRuntime, Agent, Field, Tool, ToolInputError, z } from "./index.js";
import type { ToolFake } from "./runtime.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME, type ToolResult } from "./types.js";

/** Run the three-step claim procedure to completion (unlocks intake tools
 * across pages), leaving /property-damage as the active skill again. */
async function completeClaimProcedure(runtime: ReturnType<typeof createInsuranceDemoRuntime>) {
  await runtime.callTool("read_skill", { skill: "/claim-procedure" });
  await runtime.callTool("complete_claim_procedure_stage");
  await runtime.callTool("complete_claim_procedure_stage");
  await runtime.callTool("complete_claim_procedure_stage");
  await runtime.callTool("read_skill", { skill: "/property-damage" });
}

describe("agent site runtime", () => {
  it("starts at the agent level, with no skill loaded, and offers the agent's skills to read_skill", () => {
    const runtime = createInsuranceDemoRuntime();
    const snapshot = runtime.snapshot();

    expect(snapshot.context).toMatchObject({ path: "", title: "", loadedSkills: [] });
    expect(snapshot.context.systemPrompt).toContain("most specific skill");
    expect(snapshot.stateSnapshot.some((line) => line.startsWith("active_skill:"))).toBe(false);
    expect(snapshot.events).toEqual([{ type: "page_loaded", path: "", context: snapshot.context }]);
    expect(snapshot.context.links).toEqual([
      {
        to: "/property-damage",
        label: "Property damage",
        description:
          "Use for describing or assessing damage to buildings and household items. NOT for filing a new claim — that always starts with the claim procedure skill.",
        scope: "global",
      },
      {
        to: "/policy-questions",
        label: "Policy questions",
        description: "Use for coverage questions, deductibles, and policy details.",
        scope: "global",
      },
      {
        to: "/claim-procedure",
        label: "Claim procedure",
        description:
          "Use FIRST whenever the user wants to file or report a new claim of any kind — the mandatory ordered workflow: safety, evidence, then intake.",
        scope: "global",
      },
      {
        to: "/member-portal",
        label: "Member portal",
        description: "Use for member-only content.",
        scope: "global",
      },
    ]);
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("read_skill");
    const readSkill = snapshot.context.tools.find((tool) => tool.name === "read_skill");
    expect(readSkill?.inputSchema.properties.skill.description).toBe(
      'The skill\'s path, passed exactly as written here. One of: "/property-damage" (Property damage), ' +
        '"/policy-questions" (Policy questions), "/claim-procedure" (Claim procedure), "/member-portal" (Member portal)',
    );
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("request_callback");
    expect(snapshot.context.tools.find((tool) => tool.name === "request_callback")?.scope).toBe("global");
  });

  it("refuses a read_skill of a path that is no skill, naming the ones it takes", async () => {
    const runtime = createInsuranceDemoRuntime();

    const { result } = await runtime.callTool("read_skill", { skill: "/" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown skill "/".');
    expect(result.message).toContain('"/property-damage"');
    expect(runtime.snapshot().context.loadedSkills).toEqual([]);
  });

  it("loads sub-page skills and turns forms into tools", async () => {
    const runtime = createInsuranceDemoRuntime();

    await runtime.callTool("read_skill", { skill: "/property-damage" });
    let snapshot = runtime.snapshot();

    expect(snapshot.context.path).toBe("/property-damage");
    expect(snapshot.context.instructions[0]).toContain("property damage");
    expect(snapshot.context.links.map((link) => link.to)).toEqual([
      "/property-damage",
      "/policy-questions",
      "/claim-procedure",
      "/member-portal",
    ]);
    // The intake tool is structurally gated on the shared claim-procedure
    // state: before the procedure it does not exist, only the locked notice.
    expect(snapshot.context.tools.map((tool) => tool.name)).not.toContain(
      "submit_property_damage_claim",
    );
    expect(snapshot.context.content.join("\n")).toContain("Claim intake is locked");
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("request_callback");

    await completeClaimProcedure(runtime);
    snapshot = runtime.snapshot();

    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("submit_property_damage_claim");
    const claimTool = snapshot.context.tools.find((tool) => tool.name === "submit_property_damage_claim");
    expect(claimTool?.inputSchema.required).toEqual(["name", "email", "description"]);
    expect(claimTool?.inputSchema.properties.email).toMatchObject({
      type: "string",
      format: "email",
    });
    expect(claimTool?.scope).toBe("page");
  });

  it("exposes global form tools on every page", async () => {
    const runtime = createInsuranceDemoRuntime();
    await runtime.callTool("read_skill", { skill: "/policy-questions" });

    const result = await runtime.callTool("request_callback", {
      name: "Ada Lovelace",
      phone: "+491234567",
      topic: "Coverage limits",
    });

    expect(result.result).toMatchObject({
      ok: true,
    });
    expect(runtime.snapshot().context.content).toContain("Callback request was recorded.");
  });

  it("loads context markdown referenced by skills", async () => {
    const runtime = createInsuranceDemoRuntime();

    await runtime.callTool("read_skill", { skill: "/policy-questions" });
    await runtime.callTool("read_skill", { skill: "/policy-questions/coverage" });
    const snapshot = runtime.snapshot();

    expect(snapshot.context.content.join("\n")).toContain("Property damage");
    expect(snapshot.context.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "doc",
          src: "policy/coverage-basics.md",
        }),
      ]),
    );
  });

  it("unlocks member content after a kugelaudio email is verified", async () => {
    const runtime = createInsuranceDemoRuntime();

    await runtime.callTool("read_skill", { skill: "/member-portal" });
    let snapshot = runtime.snapshot();

    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("verify_member_email");
    expect(snapshot.context.content.join("\n")).not.toContain("Priority claims line");
    // Plain primitives, no pattern block: the locked branch is an ordinary
    // tool carrying the author's icon, rendered as a normal tool block.
    expect(snapshot.context.tools.find((tool) => tool.name === "verify_member_email")).toMatchObject({
      icon: "lock",
    });
    expect(snapshot.context.blocks.find((block) => block.type === "block")).toBeUndefined();
    expect(snapshot.context.blocks).toContainEqual({ type: "tool", name: "verify_member_email" });

    const rejected = await runtime.callTool("verify_member_email", { email: "guest@gmail.com" });
    expect(rejected.result.ok).toBe(false);

    const accepted = await runtime.callTool("verify_member_email", { email: "max@example.com" });
    snapshot = runtime.snapshot();

    expect(accepted.result.ok).toBe(true);
    expect(snapshot.context.tools.map((tool) => tool.name)).not.toContain("verify_member_email");
    expect(snapshot.context.content.join("\n")).toContain("Signed in as max@example.com.");
    expect(snapshot.context.content.join("\n")).toContain("Member profile: Max");
    expect(snapshot.context.content.join("\n")).toContain("MBR-284719");
    expect(snapshot.context.content.join("\n")).toContain("Priority claims line");
  });

  it("gates a SKILL behind the member gate — loadable only after verification", async () => {
    const runtime = createInsuranceDemoRuntime();

    await runtime.callTool("read_skill", { skill: "/member-portal" });
    let snapshot = runtime.snapshot();

    // Locked: the members-only skill is not offered to the model at all —
    // no available_skill line, no read_skill option.
    expect(snapshot.context.links.map((link) => link.to)).not.toContain(
      "/member-portal/priority-claim",
    );

    await runtime.callTool("verify_member_email", { email: "max@example.com" });
    snapshot = runtime.snapshot();

    // Unlocked: the skill link exists (page scope) and is loadable.
    expect(snapshot.context.links.find((link) => link.to === "/member-portal/priority-claim"))
      .toMatchObject({ label: "Priority claim", scope: "page" });

    await runtime.callTool("read_skill", { skill: "/member-portal/priority-claim" });
    snapshot = runtime.snapshot();
    expect(snapshot.context.path).toBe("/member-portal/priority-claim");
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("file_priority_claim");
  });

  it("adds validation errors to context after failed form submission", async () => {
    const runtime = createInsuranceDemoRuntime();
    await completeClaimProcedure(runtime);

    const result = await runtime.callTool("submit_property_damage_claim", {
      name: "Ada Lovelace",
      email: "not-an-email",
      description: "Water damage in the basement.",
    });

    const snapshot = runtime.snapshot();
    const contextChangedEvents = snapshot.events.filter((event) => event.type === "context_changed");

    expect(result.result.ok).toBe(false);
    expect(snapshot.context.toolErrors).toEqual({
      submit_property_damage_claim: "Email address is invalid. Ask the user for a corrected email address.",
    });
    expect(snapshot.context.errors).toEqual([
      "Email address is invalid. Ask the user for a corrected email address.",
    ]);
    expect(contextChangedEvents.at(-1)).toMatchObject({
      type: "context_changed",
      added: ["error: Email address is invalid. Ask the user for a corrected email address."],
    });
  });

  it("turns thrown tool input errors into agent-visible errors", async () => {
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          name="reject_bad_input"
          description="Reject user-correctable input."
          onCall={() => {
            throw new ToolInputError("The provided value is not acceptable.");
          }}
        />
      </Agent>,
    );

    const { result, contextDiff } = await runtime.callTool("reject_bad_input");
    const snapshot = runtime.snapshot();

    expect(result).toEqual({
      ok: false,
      message: "The provided value is not acceptable.",
      data: undefined,
    });
    expect(snapshot.context.errors).toContain("The provided value is not acceptable.");
    // The error surfaces in the context diff returned to the transcript.
    expect(contextDiff.some((line) => line.includes("The provided value is not acceptable."))).toBe(true);
  });

  it("turns an unexpected tool exception into a failed result without the raw error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          name="crash"
          description="Fails with an internal error."
          onCall={() => {
            throw new Error("ECONNREFUSED 10.0.0.7:5432");
          }}
        />
      </Agent>,
    );

    const { result } = await runtime.callTool("crash");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("internal error");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(runtime.snapshot().context)).not.toContain("ECONNREFUSED");
    // The developer still gets the real error, server-side.
    expect(String(logged.mock.calls[0]?.[1])).toContain("ECONNREFUSED");
    logged.mockRestore();
  });

  it("notifies subscribers on loadSkill and callTool, and stops after unsubscribe", async () => {
    const runtime = createInsuranceDemoRuntime();
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    runtime.loadSkill("/property-damage");
    expect(notifications).toBe(1);

    await runtime.callTool("request_callback", {
      name: "Ada Lovelace",
      phone: "+491234567",
      topic: "Coverage limits",
    });
    expect(notifications).toBe(2);

    unsubscribe();
    runtime.loadSkill("/policy-questions");
    expect(notifications).toBe(2);
  });

  it("removes validation errors after successful form submission", async () => {
    const runtime = createInsuranceDemoRuntime();
    await completeClaimProcedure(runtime);
    await runtime.callTool("submit_property_damage_claim", {
      name: "Ada Lovelace",
      email: "not-an-email",
      description: "Water damage in the basement.",
    });

    const result = await runtime.callTool("submit_property_damage_claim", {
      name: "Ada Lovelace",
      email: "ada@example.com",
      description: "Water damage in the basement.",
    });

    const snapshot = runtime.snapshot();
    const lastContextChange = snapshot.events.filter((event) => event.type === "context_changed").at(-1);

    expect(result.result.ok).toBe(true);
    expect(snapshot.context.toolErrors).toEqual({});
    expect(snapshot.context.errors).toEqual([]);
    expect(snapshot.context.content).toContain("Property damage claim intake was accepted.");
    expect(lastContextChange).toMatchObject({
      type: "context_changed",
      added: ["content: Property damage claim intake was accepted."],
      removed: ["error: Email address is invalid. Ask the user for a corrected email address."],
    });
  });

  it("always exposes skip_turn, even on an agent with no skill links", () => {
    // Unlike read_skill (gated on links existing), skip_turn must be
    // available on every agent so the model can always end a turn with
    // no reply — a bare agent with no <Skills> at all.
    const runtime = new AgentSiteRuntime(<Agent>Nothing here.</Agent>);
    const snapshot = runtime.snapshot();

    expect(snapshot.context.links).toEqual([]);
    expect(snapshot.context.tools.map((tool) => tool.name)).not.toContain("read_skill");
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain(SKIP_TURN_TOOL_NAME);
  });

  it("end_call exists only while a call is attached", async () => {
    const runtime = createInsuranceDemoRuntime();
    const toolNames = () => runtime.snapshot().context.tools.map((tool) => tool.name);

    // A typed session has no call to hang up, so the model never sees the
    // tool — rather than seeing one it could only fail to honor.
    expect(toolNames()).not.toContain(END_CALL_TOOL_NAME);
    await expect(runtime.callTool(END_CALL_TOOL_NAME, {})).rejects.toThrow(/not available/);

    const requests: number[] = [];
    runtime.setEndCallRequest(() => requests.push(Date.now()));
    expect(toolNames()).toContain(END_CALL_TOOL_NAME);

    // The goodbye is its input: without one it is refused, and nothing hangs up.
    for (const input of [{}, { goodbye: " \n " }, { goodbye: 3 }]) {
      const refused = await runtime.callTool(END_CALL_TOOL_NAME, input);
      expect(refused.result).toMatchObject({ ok: false, message: expect.stringContaining("closing line as goodbye") });
    }
    expect(requests).toHaveLength(0);
    const outcome = await runtime.callTool(END_CALL_TOOL_NAME, { goodbye: "Take care." });
    expect(outcome.result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);

    runtime.setEndCallRequest(null);
    expect(toolNames()).not.toContain(END_CALL_TOOL_NAME);
  });

  it("runs a test's fake in place of a tool, on the input the tool's own form accepts", async () => {
    const saveNote = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
    const bookRoom = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
    const ping = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool schema={z.object({ text: z.string() })} name="save_note" description="Save a note." onSubmit={saveNote} />
        <Tool name="book_room" description="Book a room." onSubmit={bookRoom}>
          <Field name="guests" type="number" required />
        </Tool>
        <Tool name="ping" description="Ping the CRM." onCall={ping} />
      </Agent>,
    );
    const fakes = {
      save_note: vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: "Saved (fake)." })),
      book_room: vi.fn(async (): Promise<ToolResult> => ({ ok: true })),
      ping: vi.fn(async (): Promise<ToolResult> => ({ ok: false, message: "The CRM is down." })),
    };
    runtime.fakeTools(fakes);

    // Input the tool refuses never reaches its fake, and the refusal reads as the tool's own.
    expect((await runtime.callTool("save_note", {})).result).toMatchObject({ ok: false, message: "Missing required fields: text." });
    expect(fakes.save_note).not.toHaveBeenCalled();

    expect((await runtime.callTool("save_note", { text: "hi", extra: 1 })).result).toEqual({ ok: true, message: "Saved (fake)." });
    expect(fakes.save_note).toHaveBeenCalledWith({ text: "hi" });
    await runtime.callTool("book_room", { guests: "2" });
    expect(fakes.book_room).toHaveBeenCalledWith({ guests: 2 });
    expect((await runtime.callTool("ping", {})).result).toEqual({ ok: false, message: "The CRM is down." });
    expect(fakes.ping).toHaveBeenCalledTimes(1);

    expect([saveNote, bookRoom, ping].map((tool) => tool.mock.calls.length)).toEqual([0, 0, 0]);
    // Recorded like any call, and a failed result is in the context like a tool's own.
    const { events, context } = runtime.snapshot();
    expect(events.filter((event) => event.type === "tool_called").map((event) => event.name)).toEqual([
      "save_note",
      "save_note",
      "book_room",
      "ping",
    ]);
    expect(context.toolErrors).toEqual({ ping: "The CRM is down." });

    // Without a fake the tool runs again.
    runtime.fakeTools({});
    await runtime.callTool("save_note", { text: "real" });
    expect(saveNote).toHaveBeenCalledWith({ text: "real" });
  });

  it("a fake replaces exactly onSubmit: the schema's rules and transforms run first, the tool's lines follow", async () => {
    const claimSchema = z.object({
      policy: z.string().regex(/^KV-\d+$/, "A policy number looks like KV-123."),
      damage: z
        .string()
        .min(5, "Describe the damage in a few words.")
        .transform((text) => text.trim().toUpperCase()),
    });
    const onSubmit = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
    /** A fresh runtime with `create_claim`, its onSubmit `submit`, faked with `fake` when given. */
    const claims = (submit: () => Promise<ToolResult>, fake?: ToolFake) => {
      const runtime = new AgentSiteRuntime(
        <Agent>
          <Tool schema={claimSchema} name="create_claim" description="File a claim." success="The claim is filed." onSubmit={submit} />
        </Agent>,
      );
      if (fake) runtime.fakeTools({ create_claim: fake });
      return (input: Record<string, unknown>) => runtime.callTool("create_claim", input);
    };
    const fake = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
    const createClaim = claims(onSubmit, fake);

    // Input the schema refuses never reaches the fake, and the refusal is the schema's own.
    expect((await createClaim({ policy: "123", damage: "Hagel am Dach" })).result).toMatchObject({
      ok: false,
      message: "A policy number looks like KV-123.",
    });
    expect((await createClaim({ policy: "KV-123", damage: "Dach" })).result).toMatchObject({
      ok: false,
      message: "Describe the damage in a few words.",
    });
    expect(fake).not.toHaveBeenCalled();
    // The fake gets what onSubmit would get: the transform's output.
    await createClaim({ policy: "KV-123", damage: "  hagel am dach " });
    expect(fake).toHaveBeenCalledWith({ policy: "KV-123", damage: "HAGEL AM DACH" });

    // After the call, the context gains the lines a real onSubmit with the same result leaves.
    for (const result of [{ ok: true }, { ok: false, message: "The claims system is down." }]) {
      const input = { policy: "KV-123", damage: "Hagel am Dach" };
      const real = await claims(async () => result)(input);
      const faked = await claims(onSubmit, async () => result)(input);
      expect(faked).toEqual(real);
      expect(faked.contextDiff.join("\n")).toContain(result.ok ? "The claim is filed." : "The claims system is down.");
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
