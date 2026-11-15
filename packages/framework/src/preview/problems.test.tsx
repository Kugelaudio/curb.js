import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthoringDiagnostic } from "../authoring.js";
import {
  blockingSignature,
  CannotAnswerPill,
  opensByItself,
  previewProblems,
  ProblemBody,
  problemView,
  type Problem,
} from "./problems.js";

const diagnostic = (message: string, fix: string, severity: AuthoringDiagnostic["severity"] = "error"): AuthoringDiagnostic => ({
  code: "AGENT_INVALID_AUTHORING_PROP",
  severity,
  message,
  location: { source: "src/agent/agent.tsx", line: 12 },
  fix,
});
const missing = (d: AuthoringDiagnostic): Problem => ({ kind: "missing-key", diagnostic: d });

const openai = diagnostic(
  'The agent\'s llm is openai("gpt-5"), which needs OPENAI_API_KEY, and this process does not have it.',
  "Set OPENAI_API_KEY in the project's .env (see .env.example): `curb dev` reloads when you save it.",
);
const login = diagnostic(
  'The agent\'s llm is kugelaudio.llm({ model: "qwen3.8-27b" }), which needs KUGELAUDIO_API_KEY, and this process does not have it.',
  "Run `npx curb login` in the project to sign in in the browser. Or set KUGELAUDIO_API_KEY (an API key from the dashboard).",
);
const issuedByWorkspace = diagnostic(
  login.message,
  "This workspace supplies KUGELAUDIO_API_KEY itself and has not issued it yet. Wait a minute; nothing needs to be set.",
);
const warning = diagnostic("A leftover `<AgentRouter>` renders nothing.", "Remove it from `agent.tsx`.", "warning");
const error = diagnostic("The skill has no description.", "Add `description` to its `<Skill>`.");

describe("the window of the agent's problems", () => {
  it("puts what stops the agent first, then errors, then warnings", () => {
    expect(previewProblems([login], [warning, error]).map((problem) => problem.kind)).toEqual([
      "missing-key",
      "error",
      "warning",
    ]);
    expect(previewProblems([], [])).toEqual([]);
  });

  it("heads a missing key with its variable and gives the .env line to paste", () => {
    expect(problemView(missing(openai))).toEqual({
      label: "Missing key",
      headline: "OPENAI_API_KEY is not set",
      step: { where: "env", line: "OPENAI_API_KEY=" },
    });
  });

  it("gives the sign-in as the line when the fix names it", () => {
    expect(problemView(missing(login)).step).toEqual({ where: "terminal", line: "npx curb login" });
  });

  it("gives nothing to paste when the fix asks for nothing to be set", () => {
    expect(problemView(missing(issuedByWorkspace)).step).toBeNull();
  });

  it("heads any other problem with its own message, and has no line for it", () => {
    expect(problemView({ kind: "warning", diagnostic: warning })).toEqual({ label: "Warning", headline: null, step: null });
    expect(problemView(missing(diagnostic("No model can run.", "Configure one."))).headline).toBeNull();
  });

  it("shows a missing key as a line to copy and its fix, with no backticks left", () => {
    const html = renderToStaticMarkup(<ProblemBody problem={missing(login)} />);
    expect(html).toContain("Missing key");
    expect(html).toContain("KUGELAUDIO_API_KEY is not set");
    expect(html).toContain('aria-label="Copy command"');
    expect(html).toContain('<code class="inline-code">npx curb login</code>');
    expect(html).not.toContain("`");
  });

  it("shows a problem in the code with where it is and its code", () => {
    const html = renderToStaticMarkup(<ProblemBody problem={{ kind: "error", diagnostic: error }} />);
    expect(html).toContain("The skill has no description.");
    expect(html).toContain("src/agent/agent.tsx:12 · AGENT_INVALID_AUTHORING_PROP");
    expect(html).toContain('<code class="inline-code">&lt;Skill&gt;</code>');
  });

  it("opens by itself once for each problem that stops the agent, never for none", () => {
    const signature = blockingSignature([login]);
    expect(opensByItself(signature, null)).toBe(true);
    expect(opensByItself(signature, signature)).toBe(false);
    expect(opensByItself(blockingSignature([openai]), signature)).toBe(true);
    expect(opensByItself(blockingSignature([]), null)).toBe(false);
  });

  it("leaves a pill over the conversation that opens it again", () => {
    const html = renderToStaticMarkup(<CannotAnswerPill onOpen={() => undefined} />);
    expect(html).toContain("Your agent cannot answer yet");
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
