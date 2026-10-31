import { scenario } from "curb/testing";

export default scenario({
  name: "Fragen zum Schutz werden aus dem Leistungsüberblick beantwortet",
  turns: ["Ist Starkregen mitversichert?"],
  expect: ({ called, said }) => [called("read_skill", { skill: "/vertrag" }), said(/elementar/i)],
});
