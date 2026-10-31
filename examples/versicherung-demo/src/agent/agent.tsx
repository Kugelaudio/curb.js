import {
  Agent,
  GlobalTools,
  Skill,
  Skills,
  SystemPrompt,
  Tool,
  createAgentStore,
  defineAgent,
  z,
} from "curb";
import { azure, kugelaudio } from "curb/providers";

/**
 * Nora, customer service for a German property insurer.
 *
 * The demo agent. Small enough to walk through end to end in fifteen minutes,
 * and still covers the three things that separate curb from a configuration
 * platform:
 *
 *   1. Context is re-rendered from state on EVERY turn. What the agent may do
 *      is a function of the conversation so far, not a rule in the prompt you
 *      hope it follows.
 *   2. Skills load on demand (`read_skill`), tools included. The agent starts
 *      small and stays small: a conversation starts at the agent level, this
 *      file (prompt, skills index, one global tool), and fetches domain
 *      knowledge and tools only once it needs them.
 *   3. Flows are components (`<Procedure>`), so they are reusable across
 *      clients and testable with ordinary unit tests. Locks are plain
 *      if/else over state; there is NO `<Gate>` block in the framework, even
 *      though authoring.md describes one.
 *
 * Language split, deliberate: everything the MODEL or the CALLER sees is
 * German (prompts, instructions, skill descriptions, tool names, route paths,
 * the markdown under context/). Everything only a DEVELOPER reads is English.
 *
 * The shared store below drives (1): `firstStepsDone` is set in /ablauf and
 * decides in the claim skills whether the intake tool EXISTS AT ALL.
 */
export const useStore = createAgentStore<{
  /** Set once the three immediate measures have been worked through. */
  firstStepsDone: boolean;
  completeFirstSteps: () => void;
  /** The verified customer number, or null. Unlocks the account area. */
  customerNumber: string | null;
  verify: (customerNumber: string) => void;
}>("insurance", (set) => ({
  firstStepsDone: false,
  completeFirstSteps: () => set({ firstStepsDone: true }),
  customerNumber: null,
  verify: (customerNumber) => set({ customerNumber }),
}));

const callbackSchema = z.object({
  name: z.string().min(1).describe("Vollständiger Name der anrufenden Person."),
  phone: z.string().min(1).describe("Telefonnummer für den Rückruf."),
  topic: z.string().min(1).describe("Worum es beim Rückruf gehen soll."),
});

export function InsuranceApp() {
  return (
    // Voice and language in one place, and authored rather than left to the
    // environment. Without a voice, the default follows the TTS language (1072
    // for English, 1887 for German); this demo names its own German voice.
    //
    // dictionaryIds and projectId name a brand-pronunciation dictionary in
    // another project. With your own key, use your project's dictionary ids or
    // leave both out.
    <Agent
      stt={azure.stt({ language: "de" })}
      tts={kugelaudio.tts({ voice: 1840, language: "de", dictionaryIds: [120], projectId: 13 })}
    >
      <SystemPrompt>{`
        Du bist Nora, Kundenservice einer Sachversicherung.
        Dein Kontext enthält Anweisungen und Werkzeuge für die Fähigkeiten, die du geladen hast.

        ## Fähigkeiten und Werkzeuge
        - Nutze das Werkzeug read_skill stillschweigend, sobald das Thema der anrufenden Person Anweisungen oder Werkzeuge erfordert, die du noch nicht hast.
        - Kündige das Laden nie an, erkläre es nicht, fasse es nicht zusammen, und sende im selben Zug keinen Text an die anrufende Person.
        - Fahre fort, als hättest du das Thema immer gekonnt.
        - Wenn ein Ablauf vorliegt, arbeite seine Schritte der Reihe nach ab.
        - Rufe ausschließlich Werkzeuge auf, die in deinem aktuellen Kontext stehen; erfinde niemals Werkzeuge, Felder oder Empfänger.

        ## Sprechen
        - Sprich klar und natürlich, in ein bis zwei Sätzen: du bist am Telefon.
        - Sprich nie über Abschnitte, Seiten, Navigation, Fähigkeiten, Pfade oder Werkzeuge, außer die anrufende Person fragt, wie das System funktioniert.
        - Verwende NIE Emojis, Markdown, Aufzählungszeichen oder Überschriften, auch nicht im Textchat.
          Alles, was du schreibst, kann im nächsten Moment vorgelesen werden.

        ## Einstieg
        - Begrüße die anrufende Person kurz als Nora von der Sachversicherung und frage, worum es geht.
        - Antworte nicht fachlich, bevor klar ist, worum es überhaupt geht.
        - Häufige Anliegen: einen neuen Schaden melden, Fragen zum Versicherungsschutz, Auskunft zu den eigenen Vertragsdaten.

        ## Länge, hart
        - Höchstens zwei bis drei kurze Sätze, ungefähr vierzig Wörter. Länger nur, wenn ausdrücklich nach Details gefragt wird.
        - Stelle höchstens EINE Frage pro Antwort.
        - Nenne nie mehr als zwei Punkte aus einer Aufzählung.
        - Frage Angaben nacheinander ab, nie mehrere in einem Zug. Das ist ein Gespräch, kein Formular.
      `}</SystemPrompt>

      {/* The descriptions ARE the routing table. The model reads them to decide
          what to load, which is why they are phrased as rules, negative ones
          included. */}
      <Skills>
        <Skill
          path="/ablauf"
          description="ZUERST nutzen, wenn jemand einen neuen Schaden melden will - die drei verbindlichen Sofortmaßnahmen: Gefahr abwenden, Nachweise sichern, dann zur Aufnahme."
        >
          Sofortmaßnahmen
        </Skill>
        <Skill
          path="/schaden"
          description="Für die Aufnahme eines Schadens in einer der Sparten: Gebäude und Hausrat, Kfz, Haftpflicht, Rechtsschutz. NICHT für den Einstieg in eine neue Meldung - der beginnt immer mit den Sofortmaßnahmen."
        >
          Schaden melden
        </Skill>
        <Skill
          path="/vertrag"
          description="Für Fragen zum Versicherungsschutz, zu Leistungen und zu Vertragsdetails."
        >
          Vertragsfragen
        </Skill>
        <Skill path="/kundenkonto" description="Für persönliche Vertrags- und Kontodaten der anrufenden Person.">
          Kundenkonto
        </Skill>
      </Skills>

      <GlobalTools>
        <Tool
          schema={callbackSchema}
          name="rueckruf_anfordern"
          description="Einen Rückruf durch eine menschliche Beraterin oder einen Berater anfordern."
          success="Der Rückruf wurde vorgemerkt."
          tryWith={{ name: "Erika Mustermann", phone: "+49 30 1234567", topic: "Rückfrage zum Vorgang SD-2026-4471" }}
          onSubmit={(input) => ({ ok: true, data: input })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: InsuranceApp,
  // The deepest demo path is three skills: /ablauf -> /schaden -> an insurance line, and a
  // caller may ask about /vertrag on the way. A budget of 3 would then evict the immediate
  // measures mid-flow.
  maxLoadedSkills: 5,
  firstTurn: "agent",
  preview: {
    suggestedPrompts: [
      "Ich möchte einen Wasserschaden melden",
      "Was ist bei einem Leitungswasserschaden versichert?",
      "Ich hätte gern meine Vertragsdaten",
    ],
    chatPlaceholder: "Ich möchte einen Schaden melden...",
  },
});
