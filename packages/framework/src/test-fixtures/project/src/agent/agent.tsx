import {
  GlobalTools,
  Agent,
  Skill,
  Skills,
  SystemPrompt,
  Tool,
  createAgentStore,
  defineAgent,
  z,
} from "../../../../index.js";
import { azure, kugelaudio } from "../../../../providers.js";

/**
 * The agent's store — shared state and the actions that change it, usable
 * from any skill. Completing the claim procedure (on /claim-procedure)
 * unlocks the intake tools on other pages (e.g. /property-damage), making
 * "a new claim always goes through the procedure" a structural invariant the
 * model cannot route around.
 */
export const useStore = createAgentStore<{
  procedureComplete: boolean;
  completeProcedure: () => void;
}>("insurance", (set) => ({
  procedureComplete: false,
  completeProcedure: () => set({ procedureComplete: true }),
}));

/**
 * The project's agent. `src/agent/` is the complete author-facing surface:
 * this module exports `agent` (a `defineAgent` result) and is the agent level
 * every conversation starts at; the `<name>/skill.tsx` modules in the folders
 * next to it are the agent's skills, opened when needed. Both are discovered
 * automatically (a filesystem walk under Node). The folder name is the agent
 * id shown in the preview's agent selector.
 *
 * The tree itself is route-loader agnostic (no `import.meta.glob` here), so
 * it renders headlessly under plain `tsx`/Node as well as in the `curb build` bundle.
 */
/** The agent's single, voice-first system prompt (authored via <SystemPrompt>
 * in the tree below). Exported so the framework tests can assert the exact
 * prompt the compiled context carries. */
export const INSURANCE_AGENT_SYSTEM_PROMPT = [
  "You are an insurance support agent. You can help with property damage, policy questions, and claim reporting.",
  "Clarify what the user needs, then read the most specific skill before collecting details.",
  "Your context includes instructions and tools for the skills you have loaded.",
  "Use the read_skill tool silently when the user's topic requires instructions or tools you do not have yet.",
  "Never announce, explain, or summarize reading a skill. After read_skill, continue as if you always knew that topic.",
  "When calling read_skill, do not send user-facing text in the same turn — call the tool only, then reply on the next turn.",
  "Use form and action tools to collect information and complete tasks.",
  "When a procedure is present, follow its steps in order before advancing.",
  "Only call tools that appear in your current context.",
  "Do not invent tools, fields, or destinations.",
  "Speak to the user in plain, conversational language.",
  "Do not mention sections, pages, navigation, skills, paths, focus, or tools unless the user asks how the system works.",
].join("\n");

const requestCallbackSchema = z.object({
  name: z.string().min(1).describe("Customer full name."),
  phone: z.string().min(1).describe("Customer phone number."),
  topic: z.string().min(1).describe("What the callback should be about."),
});

export function InsuranceApp() {
  return (
    // The agent's voice: change the voice id / language here, not in env files.
    <Agent stt={azure.stt({ language: "en" })} tts={kugelaudio.tts({ voice: 1072, language: "en" })}>
        <SystemPrompt>{INSURANCE_AGENT_SYSTEM_PROMPT}</SystemPrompt>

        <Skills>
          <Skill
            path="/property-damage"
            description="Use for describing or assessing damage to buildings and household items. NOT for filing a new claim — that always starts with the claim procedure skill."
          >
            Property damage
          </Skill>
          <Skill path="/policy-questions" description="Use for coverage questions, deductibles, and policy details.">
            Policy questions
          </Skill>
          <Skill
            path="/claim-procedure"
            description="Use FIRST whenever the user wants to file or report a new claim of any kind — the mandatory ordered workflow: safety, evidence, then intake."
          >
            Claim procedure
          </Skill>
          <Skill path="/member-portal" description="Use for member-only content.">
            Member portal
          </Skill>
        </Skills>

        <GlobalTools>
          <Tool
            schema={requestCallbackSchema}
            name="request_callback"
            description="Request a human insurance advisor callback."
            success="Callback request was recorded."
            onSubmit={(input) => ({ ok: true, data: input })}
          />
          {/* No MCP tools on this focused customer-facing agent. See
              examples/ops-agent for an MCP-heavy alternative example. */}
        </GlobalTools>
    </Agent>
  );
}

/**
 * The complete insurance demo agent: React app + everything tunable, in one
 * place. Hosts (WS server, voice bridge, preview) consume this via the agent
 * entry module (`./index.ts`) instead of hardcoding settings, so framework
 * users adjust behavior here without touching host or framework code.
 */
export const agent = defineAgent({
  app: InsuranceApp,
  maxLoadedSkills: 3,
  preview: {
    suggestedPrompts: [
      "I need to report property damage",
      "What does my policy cover?",
      "How do I file a claim?",
    ],
    chatPlaceholder: "I need to report property damage...",
  },
});
