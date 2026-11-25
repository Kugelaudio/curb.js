import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent, z } from "curb";
import { modelUnderTest } from "../../../../harness/model-under-test.js";

/** A family practice's phone line (fake practice, fake data): appointments and practice info. */
export function ClinicApp() {
  return (
    <Agent s2s={modelUnderTest("de")}>
      <SystemPrompt>{`
        Du bist die Telefonassistenz der Hausarztpraxis Dr. Sommer. Du sprichst Deutsch, freundlich und knapp,
        höchstens zwei kurze Sätze pro Antwort, eine Frage auf einmal, ohne Aufzählungen.
        Du hilfst bei Terminen (neu buchen, absagen) und beantwortest Fragen zur Praxis.
        Freie Termine, Buchungen und Absagen kennt nur das Praxissystem; erfinde nie Termine oder Uhrzeiten.
        Wenn jemand mit einem Menschen sprechen möchte oder ein medizinisches Anliegen hat, das du nicht klären kannst,
        nimm einen Rückrufwunsch auf.
      `}</SystemPrompt>

      <Skills>
        <Skill path="/termin-buchen" description="Einen neuen Termin vereinbaren: freie Termine suchen und buchen.">
          Termin buchen
        </Skill>
        <Skill path="/termin-absagen" description="Einen bestehenden Termin finden und absagen.">
          Termin absagen
        </Skill>
        <Skill path="/praxis-infos" description="Öffnungszeiten, Adresse, Anfahrt, Parken, Versicherung, Rezepte.">
          Praxis-Infos
        </Skill>
      </Skills>

      <GlobalTools>
        <Tool
          name="rueckruf_anfordern"
          description="Einen Rückruf durch das Praxisteam anfordern, wenn der Anrufer einen Menschen sprechen möchte."
          schema={z.object({
            name: z.string().min(2).describe("Vor- und Nachname des Anrufers."),
            telefon: z.string().min(5).describe("Rückrufnummer, nur Ziffern."),
            anliegen: z.string().min(3).describe("Worum es geht, in einem Satz."),
          })}
          onSubmit={(input) => ({ ok: true, message: `Rückruf für ${input.name} unter ${input.telefon} ist eingetragen.` })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: ClinicApp,
  firstTurn: { say: "Praxis Doktor Sommer, guten Tag. Wie kann ich Ihnen helfen?" },
  timeZone: "Europe/Berlin",
});
