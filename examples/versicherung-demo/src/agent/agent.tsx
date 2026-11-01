import {
  Agent,
  GlobalTools,
  Skill,
  Skills,
  SystemPrompt,
  Tool,
  TransferCallTool,
  createAgentStore,
  defineAgent,
  z,
} from "curb";
import { kugelaudio } from "curb/providers";

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
 *      if/else over state.
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
    // One key runs all of it: the LLM, speech recognition and the voice are KugelAudio's. The
    // voice is the default for German. boostedPhrases makes Ear expect the words a caller of
    // this insurer says; add product names, tariffs and your brand here.
    //
    // Mistral, not the default Qwen: this agent depends on a tool call in the caller's first
    // turn, and on Qwen that call went missing in 9 of 30 tries (Mistral 0 of 30,
    // 2026-10-30). Qwen then says "ich stelle Sie durch" and nothing happens.
    <Agent
      llm={kugelaudio.llm({ model: "mistral-medium-3.5-128b" })}
      stt={kugelaudio.stt({
        language: "de",
        boostedPhrases: ["Selbstbeteiligung", "Elementarschutz", "Vollkasko", "Teilkasko", "Tagebuchnummer"],
      })}
      tts={kugelaudio.tts({ language: "de" })}
    >
      <SystemPrompt>{`
        Du bist Nora, Kundenservice einer Sachversicherung.
        Dein Kontext enthält Anweisungen und Werkzeuge für die Fähigkeiten, die du geladen hast.
        Antworte immer auf Deutsch.

        ## Fähigkeiten und Werkzeuge
        - Sobald das Anliegen klar ist, rufe read_skill auf, bevor du inhaltlich antwortest, auch im ersten Zug. Antworte nie aus dem Kopf zu Schäden, Versicherungsschutz oder Vertragsdaten.
        - Kündige das Laden nie an, erkläre es nicht, fasse es nicht zusammen, und sende im selben Zug keinen Text an die anrufende Person.
        - Fahre fort, als hättest du das Thema immer gekonnt.
        - Wenn ein Ablauf vorliegt, arbeite seine Schritte der Reihe nach ab.
        - Rufe ausschließlich Werkzeuge auf, die in deinem aktuellen Kontext stehen; erfinde niemals Werkzeuge, Felder oder Empfänger.

        ## Satzfetzen
        - Bruchstücke ohne erkennbares Anliegen ("Aber.", "Ich glaube.") sind keine Bitte: Rufe skip_turn auf und warte. Lade dafür keine Fähigkeit.
        - Bleibt es unklar, frage höchstens einmal, worum es geht. Sage nie denselben Satz zweimal.
        - Sprich die Person nur mit einem Namen an, den sie selbst genannt hat.

        ## Sprechen
        - Sprich klar und natürlich, in ein bis zwei Sätzen: du bist am Telefon.
        - Sprich nie über Abschnitte, Seiten, Navigation, Fähigkeiten, Pfade oder Werkzeuge, außer die anrufende Person fragt, wie das System funktioniert.
        - Verwende NIE Emojis, Markdown, Aufzählungszeichen oder Überschriften, auch nicht im Textchat.
          Alles, was du schreibst, kann im nächsten Moment vorgelesen werden.

        ## Menschen
        - Wer ausdrücklich mit einem Menschen sprechen will, wird sofort verbunden: nutze verbinden_mit_berater und frage nichts mehr vorher.
        - Klappt das Verbinden nicht, biete einen Rückruf an.

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
        {/* The number is an invented placeholder: put your service desk here. On a phone call
            it dials; in `curb dev` a transfer is refused, and the model offers the callback. */}
        <TransferCallTool
          name="verbinden_mit_berater"
          description="Die anrufende Person zu einer Beraterin oder einem Berater durchstellen."
          to="+493012345678"
          ringTimeoutSeconds={25}
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
  // Said word for word: a caller has to learn they are talking to an AI, and that sentence
  // must not depend on what the model feels like writing.
  firstTurn: {
    say: "Guten Tag, hier ist Nora, die digitale Assistentin Ihrer Sachversicherung. Ich bin eine KI. Worum geht es?",
  },
  goals: {
    schaden_aufgenommen: {
      description: "Ein Schaden wurde aufgenommen und die Vorgangsnummer genannt.",
      judge: "Ein Schaden wurde aufgenommen und der anrufenden Person wurde eine Vorgangsnummer genannt.",
    },
    an_mensch_uebergeben: { description: "Die anrufende Person wurde verbunden.", tool: "verbinden_mit_berater" },
    rueckruf_vorgemerkt: { description: "Ein Rückruf wurde vorgemerkt.", tool: "rueckruf_anfordern" },
  },
  preview: {
    suggestedPrompts: [
      "Ich möchte einen Wasserschaden melden",
      "Was ist bei einem Leitungswasserschaden versichert?",
      "Ich hätte gern meine Vertragsdaten",
    ],
    chatPlaceholder: "Ich möchte einen Schaden melden...",
  },
});
