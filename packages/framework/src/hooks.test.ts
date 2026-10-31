import { describe, expect, it } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { defineAgent, type AgentDefinition } from "./config.js";
import { declaredHook, hookDeclarations } from "./hooks.js";

const App = () => null;
const hook = async () => {};

/** The authoring error `action` throws, or null when it throws none. */
function authoringError(action: () => unknown): AgentAuthoringError | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof AgentAuthoringError) return error;
    throw error;
  }
}

describe("defineAgent({ afterCall, afterEvaluation })", () => {
  it("takes a function, and leaves an agent with no hooks as it was", () => {
    const agent = defineAgent({ app: App, afterCall: hook, afterEvaluation: hook });
    expect(agent.afterCall).toBe(hook);
    expect(defineAgent({ app: App })).toEqual({ app: App });
    expect(authoringError(() => defineAgent({ app: App, afterCall: undefined }))).toBeNull();
  });

  it.each([["a url"], [null], [{ run: true }], [7]])("refuses %j, naming the hook and what to do", (value) => {
    const error = authoringError(() => defineAgent({ app: App, afterEvaluation: value } as unknown as AgentDefinition));
    expect(error?.diagnostic).toMatchObject({
      code: AUTHORING_DIAGNOSTIC_CODES.hookNotAFunction,
      severity: "error",
      location: { source: "src/agent/agent.tsx", component: "defineAgent" },
    });
    expect(error?.message).toContain("afterEvaluation");
    expect(error?.diagnostic.fix).toContain("async function");
  });
});

describe("hookDeclarations", () => {
  it("is the declared names, sorted, and [] for none", () => {
    expect(hookDeclarations({})).toEqual([]);
    expect(hookDeclarations({ afterEvaluation: hook })).toEqual(["afterEvaluation"]);
    expect(hookDeclarations({ afterEvaluation: hook, afterCall: hook })).toEqual(["afterCall", "afterEvaluation"]);
  });

  it("refuses an agent that skipped defineAgent rather than dropping its hook from the manifest", () => {
    expect(() => hookDeclarations({ afterCall: "later" } as never)).toThrow(/not a function/);
  });
});

describe("declaredHook", () => {
  it("is the hook, or a refusal that says what to add", () => {
    expect(declaredHook({ afterCall: hook }, "afterCall")).toBe(hook);
    expect(authoringError(() => declaredHook({ afterCall: hook }, "afterEvaluation"))?.diagnostic).toMatchObject({
      code: AUTHORING_DIAGNOSTIC_CODES.hookNotDeclared,
      message: "The agent declares no afterEvaluation, so there is nothing to run.",
    });
  });

  it("refuses a name that is no hook, naming the ones there are", () => {
    expect(authoringError(() => declaredHook({ afterCall: hook }, "afterHours"))?.message).toContain(
      "the hooks are afterCall and afterEvaluation",
    );
  });
});
