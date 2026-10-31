import { Instruction, Skill, Text, Tool, z, type SkillMeta } from "curb";
import { kundeLesen, kundePruefen } from "../../kunden.js";
import { useStore } from "../agent.js";

export const meta: SkillMeta = {
  title: "Kundenkonto",
  description: "Persönliche Vertrags- und Kontodaten, nach Verifizierung.",
};

const verifySchema = z.object({
  customerNumber: z
    .string()
    .regex(/^K-\d{6}$/, "Kundennummern haben die Form K-123456. Frage noch einmal nach.")
    .describe("Kundennummer in der Form K-123456."),
  birthYear: z
    .string()
    .regex(/^\d{4}$/, "Bitte ein vierstelliges Geburtsjahr.")
    .describe("Geburtsjahr der versicherten Person, vierstellig."),
});

/**
 * DEMO POINT 1, second and stronger form: a locked SKILL.
 *
 * The locked tool under /schaden is already clear. This is clearer: until
 * verification the link to /kundenkonto/prioritaet is not in context at all, so
 * the model cannot even KNOW the capability exists. It does not decline it. It
 * does not exist for it.
 *
 * For a data protection officer that is the difference between "we told the
 * model not to" and "the model never had it". Only the second survives an
 * audit.
 *
 * Deliberately a plain if/else over state rather than a dedicated block: the
 * rendered branch IS the context, and no more machinery is needed.
 */
export default function CustomerAccount() {
  const customerNumber = useStore((s) => s.customerNumber);
  const verify = useStore((s) => s.verify);
  const kunde = customerNumber ? kundeLesen(customerNumber) : null;

  return (
    <>
      <Instruction>{`
        Persönliche Daten gibst du erst nach Verifizierung heraus.
        Frage freundlich nach Kundennummer und Geburtsjahr: beides zusammen, in einem Satz, nicht wie ein Verhör.
      `}</Instruction>

      {kunde ? (
        <>
          <Text>{`
            Verifiziert als ${kunde.name}, ${kunde.kundennummer}.
            - Tarif: ${kunde.tarif}, Versicherungssumme ${kunde.versicherungssumme}
            - Vertrag seit: ${kunde.vertragSeit}
            - Selbstbeteiligung: ${kunde.selbstbeteiligung}
            - Beitrag: ${kunde.beitrag}
            - Bausteine: ${kunde.bausteine.join(", ") || "keine"}
            - Offene Vorgänge: ${kunde.offeneVorgaenge.join("; ") || "keine"}
          `}</Text>
          {/* THE LOCKED SKILL: linked only in this branch, so only discoverable
              after verification. */}
          <Skill
            path="/kundenkonto/prioritaet"
            description="Für die bevorzugte Schadenbearbeitung, die Bestandskundinnen und -kunden zusteht."
          >
            Bevorzugte Bearbeitung
          </Skill>
        </>
      ) : (
        <>
          <Text>{`
            Die Kontodaten sind gesperrt, bis Kundennummer und Geburtsjahr bestätigt sind.
            Frage beides ab und nutze dann das Verifizierungswerkzeug; danach stehen die persönlichen Daten zur Verfügung.
          `}</Text>
          <Tool
            schema={verifySchema}
            name="kundenkonto_verifizieren"
            description="Kundennummer und Geburtsjahr prüfen und das Kundenkonto freischalten."
            success="Das Kundenkonto wurde freigeschaltet."
            tryWith={{ customerNumber: "K-100200", birthYear: "1985" }}
            onSubmit={(input) => {
              const treffer = kundePruefen(input.customerNumber, input.birthYear);
              if (!treffer) {
                return { ok: false, message: "Die Angaben passen nicht zusammen. Bitte noch einmal erfragen." };
              }
              verify(treffer.kundennummer);
              return { ok: true, message: `Freigeschaltet als ${treffer.name}.` };
            }}
          />
        </>
      )}
    </>
  );
}
