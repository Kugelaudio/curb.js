import { Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Filialen und Gebühren",
  description: "Öffnungszeiten der Filialen, Gebühren, Geldautomaten.",
};

export default function FilialenInfos() {
  return (
    <Text>{`
      Filialen haben Montag bis Freitag von 9 bis 17 Uhr geöffnet, donnerstags bis 18 Uhr. Samstags sind alle Filialen geschlossen.
      Das Girokonto kostet 4,90 Euro im Monat; für unter 27-Jährige ist es kostenlos.
      Eine Ersatzkarte kostet 10 Euro. An Geldautomaten der Lindenbank ist das Abheben kostenlos.
    `}</Text>
  );
}
