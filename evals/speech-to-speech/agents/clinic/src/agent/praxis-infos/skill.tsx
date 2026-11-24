import { Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Praxis-Infos",
  description: "Öffnungszeiten, Adresse, Anfahrt, Parken, Versicherung, Rezepte.",
};

export default function PraxisInfos() {
  return (
    <Text>{`
      Öffnungszeiten: Montag bis Freitag 8 bis 12 Uhr, Montag, Dienstag und Donnerstag zusätzlich 15 bis 18 Uhr.
      Mittwoch- und Freitagnachmittag geschlossen.
      Adresse: Lindenallee 14, im ersten Stock, mit Aufzug.
      Parken: drei Parkplätze im Hof, sonst Parkhaus am Markt, fünf Minuten zu Fuß.
      Versicherung: gesetzlich und privat Versicherte sind willkommen.
      Folgerezepte: bis 10 Uhr bestellt, ab 16 Uhr am selben Tag abholbereit.
    `}</Text>
  );
}
