import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Karte sperren",
  description: "Eine Karte eines geprüften Kunden sperren.",
};

export default function KarteSperren() {
  return (
    <>
      <Instruction>Frag nach den letzten vier Ziffern der Karte und ob sie verloren, gestohlen oder beschädigt ist, und sperr sie mit karte_sperren.</Instruction>
      <Tool
        name="karte_sperren"
        description="Eine Karte des geprüften Kunden sofort sperren."
        schema={z.object({
          karten_endziffern: z.string().regex(/^\d{4}$/, "Vier Ziffern.").describe("Die letzten vier Ziffern der Karte."),
          grund: z.enum(["verloren", "gestohlen", "beschaedigt"]).describe("Warum die Karte gesperrt wird."),
        })}
        confirm={(input) => `Ich sperre die Karte mit den Endziffern ${input.karten_endziffern} sofort und endgültig. Soll ich das tun?`}
        onSubmit={(input) => ({ ok: true, message: `Karte ${input.karten_endziffern} ist gesperrt. Eine neue Karte kommt in fünf Werktagen.` })}
      />
    </>
  );
}
