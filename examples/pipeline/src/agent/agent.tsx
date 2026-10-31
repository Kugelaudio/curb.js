import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, createAgentStore, defineAgent, z } from "curb";
import { kugelaudio } from "curb/providers";

const useLanguage = createAgentStore<{ language: "en" | "de"; setLanguage: (language: "en" | "de") => void }>(
  "language",
  (set) => ({ language: "en", setLanguage: (language) => set({ language }) }),
);

export function App() {
  const language = useLanguage((state) => state.language);
  const setLanguage = useLanguage((state) => state.setLanguage);
  return (
    <Agent
      stt={kugelaudio.stt({ language, boostedPhrases: ["Curb", "Kugel Ear"] })}
      tts={kugelaudio.tts({ language })}
      adjustable={{ client: ["tts.voice"], host: ["tts.voice", "stt.language", "llm"] }}
    >
      <SystemPrompt>You are the helpdesk of Example Software. Keep replies short.</SystemPrompt>
      <Skills>
        <Skill path="/report" description="Use when the caller wants a written summary of a problem." llm={kugelaudio.llm({ model: "mistral-medium-3.5-128b" })}>
          Report
        </Skill>
      </Skills>
      <GlobalTools>
        <Tool
          name="switch_to_german"
          description="Continue the call in German, when the caller speaks German."
          schema={z.object({})}
          onSubmit={() => {
            setLanguage("de");
            return { ok: true, message: "From your next reply on the call is in German." };
          }}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
