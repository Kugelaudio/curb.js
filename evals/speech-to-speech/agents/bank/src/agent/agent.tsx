import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Text, Tool, createAgentStore, defineAgent, z } from "curb";
import { modelUnderTest } from "../../../../harness/model-under-test.js";

/** Who the caller proved to be. Changes to an account open only after the identity check. */
export const useKunde = createAgentStore<{ kunde: string | null; bestaetigen: (kunde: string) => void }>("kunde", (set) => ({
  kunde: null,
  bestaetigen: (kunde) => set({ kunde }),
}));

/** A bank's phone service (fake bank, fake data): address change and card block after an identity check. */
export function BankApp() {
  const kunde = useKunde((state) => state.kunde);
  return (
    <Agent s2s={modelUnderTest()}>
      <SystemPrompt>{`
        Du bist der Telefonservice der Lindenbank. Du sprichst Deutsch, freundlich und knapp,
        höchstens zwei kurze Sätze pro Antwort, eine Frage auf einmal, ohne Aufzählungen.
        Du hilfst bei Adressänderungen, beim Sperren einer Karte und bei Fragen zu Filialen und Gebühren.
        Kontodaten kennt nur das Banksystem: erfinde nie Kundennummern, Adressen oder Ergebnisse.
        Wer eine Beratung möchte, etwa zu Krediten oder Geldanlage, bekommt einen Rückruf.
      `}</SystemPrompt>

      <Skills>
        {kunde === null ? (
          <Skill path="/identitaet" description="Identität prüfen: nötig vor jeder Änderung am Konto und vor dem Sperren einer Karte.">
            Identität prüfen
          </Skill>
        ) : (
          <>
            <Skill path="/adresse-aendern" description="Die Adresse eines geprüften Kunden ändern.">
              Adresse ändern
            </Skill>
            <Skill path="/karte-sperren" description="Eine Karte eines geprüften Kunden sperren.">
              Karte sperren
            </Skill>
          </>
        )}
        <Skill path="/filialen-infos" description="Öffnungszeiten der Filialen, Gebühren, Geldautomaten.">
          Filialen und Gebühren
        </Skill>
      </Skills>
      {kunde === null ? (
        <Text>Adresse ändern und Karte sperren gehen erst nach der Identitätsprüfung.</Text>
      ) : (
        <Text>{`Der Anrufer ist geprüft: ${kunde}.`}</Text>
      )}

      <GlobalTools>
        <Tool
          name="rueckruf_anfordern"
          description="Einen Rückruf durch eine Beraterin oder einen Berater anfordern."
          schema={z.object({
            name: z.string().min(2).describe("Vor- und Nachname des Anrufers."),
            telefon: z.string().min(5).describe("Rückrufnummer, nur Ziffern."),
            thema: z.string().min(3).describe("Worum es geht."),
          })}
          onSubmit={(input) => ({ ok: true, message: `Rückruf für ${input.name} unter ${input.telefon} zu "${input.thema}" ist eingetragen.` })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: BankApp,
  firstTurn: { say: "Lindenbank, Kundenservice, guten Tag. Was kann ich für Sie tun?" },
  timeZone: "Europe/Berlin",
});
