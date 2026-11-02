import { describe, expect, it } from "vitest";
import { AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { kugelaudio, openai } from "./providers.js";
import { diagnoseS2s, s2sCredentialDiagnostic } from "./s2s-diagnostics.js";
import { providerPropsFromTree } from "./session-settings.js";
import type { SemanticNode } from "./types.js";

const s2s = openai.live();
const node = (type: string, props: Record<string, unknown>, children: SemanticNode[] = []) =>
  ({ type, props, children }) as unknown as SemanticNode;
const tree = (agent: Record<string, unknown>, skill: Record<string, unknown>) =>
  node("agent-site", agent, [node("agent-skill", { to: "/a", ...skill })]);

describe("<Agent s2s> diagnostics", () => {
  it("warns about stt and tts, which a call does not use", () => {
    const atAgent = diagnoseS2s({ agentId: "a", tree: tree({ s2s, stt: kugelaudio.stt() }, {}), skillPaths: ["/a"] });
    expect(atAgent).toEqual([expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.s2sSpeechProviderIgnored, severity: "warning" })]);
    const atSkill = diagnoseS2s({ agentId: "a", tree: tree({ s2s }, { tts: kugelaudio.tts() }), skillPaths: ["/a"] });
    expect(atSkill).toHaveLength(1);
    expect(atSkill[0]?.location).toMatchObject({ skillPath: "/a" });
  });

  it("stays quiet without s2s, and with s2s alone", () => {
    expect(diagnoseS2s({ agentId: "a", tree: tree({ stt: kugelaudio.stt() }, {}), skillPaths: ["/a"] })).toEqual([]);
    expect(diagnoseS2s({ agentId: "a", tree: tree({ s2s, llm: kugelaudio.llm() }, {}), skillPaths: ["/a"] })).toEqual([]);
  });

  it("names what a call needs", () => {
    expect(s2sCredentialDiagnostic(openai.live(), { KUGELAUDIO_API_KEY: "k" })?.message).toContain("OPENAI_API_KEY");
    expect(s2sCredentialDiagnostic(openai.realtime(), {})?.message).toContain("OPENAI_API_KEY");
    expect(s2sCredentialDiagnostic(openai.realtime(), { OPENAI_API_KEY: "k" })).toBeNull();
    expect(s2sCredentialDiagnostic(openai.live(), { OPENAI_API_KEY: "k" })).toBeNull();
  });

  it("refuses a value that is no speech-to-speech model", () => {
    expect(() => providerPropsFromTree(tree({ s2s: kugelaudio.llm() }, {}), "")).toThrow(/not a s2s provider/);
  });
});
