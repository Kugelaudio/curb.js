import { describe, expect, it } from "vitest";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";

/**
 * read_skill's rejection is read by a MODEL, mid-turn, and it is the only
 * thing standing between a wrong argument and a dead turn: a model that
 * cannot see what a valid value looks like repeats the same call until the
 * step limit ends the turn with no reply at all. That is not hypothetical --
 * it is what claude-sonnet-5 did in an early demo, four identical
 * read_skill("Karriere") calls in a row, because the parameter description
 * led with the title and the error named neither the path nor the options.
 */
describe("read_skill rejects unusable input in a way a model can act on", () => {
  const readSkill = (input: Record<string, unknown>) =>
    createInsuranceDemoRuntime().callTool("read_skill", input);

  it("tells the caller which paths exist", async () => {
    const outcome = await readSkill({ skill: "nonsense" });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).toContain('"/property-damage"');
    expect(outcome.result.message).toContain('"/claim-procedure"');
  });

  it("maps a title back to its path, which is the mistake models actually make", async () => {
    const outcome = await readSkill({ skill: "Property damage" });

    expect(outcome.result.ok).toBe(false);
    // The specific correction, not just the menu: "that is a title, here is
    // the path" is one retry, a bare list is a guess.
    expect(outcome.result.message).toContain('its path is "/property-damage"');
  });

  it("matches a title case-insensitively, since the model is retyping it from prose", async () => {
    const outcome = await readSkill({ skill: "property DAMAGE" });

    expect(outcome.result.message).toContain('its path is "/property-damage"');
  });

  it("still accepts a real path", async () => {
    const runtime = createInsuranceDemoRuntime();
    const outcome = await runtime.callTool("read_skill", { skill: "/property-damage" });

    expect(outcome.result.ok).toBe(true);
    expect(runtime.snapshot().context.path).toBe("/property-damage");
  });

});
