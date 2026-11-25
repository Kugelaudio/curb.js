import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Adresse ändern",
  description: "Die Adresse eines geprüften Kunden ändern.",
};

export default function AdresseAendern() {
  return (
    <>
      <Instruction>Frag nach Straße, Hausnummer, Postleitzahl und Ort der neuen Adresse und ändere sie mit adresse_aendern.</Instruction>
      <Tool
        name="adresse_aendern"
        description="Die Adresse des geprüften Kunden ändern."
        schema={z.object({
          strasse: z.string().min(2).describe("Straße, ohne Hausnummer."),
          hausnummer: z.string().min(1).describe("Hausnummer."),
          plz: z.string().regex(/^\d{5}$/, "Die Postleitzahl hat fünf Ziffern.").describe("Postleitzahl."),
          ort: z.string().min(2).describe("Ort."),
        })}
        confirm={(input) => `Ich ändere Ihre Adresse auf ${input.strasse} ${input.hausnummer}, ${input.plz} ${input.ort}. Ist das richtig?`}
        onSubmit={(input) => ({ ok: true, message: `Adresse geändert auf ${input.strasse} ${input.hausnummer}, ${input.plz} ${input.ort}.` })}
      />
    </>
  );
}
