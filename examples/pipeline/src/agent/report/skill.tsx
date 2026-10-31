import { Instruction } from "curb";

export const meta = { title: "Report", description: "A written summary of a problem." };

export default function Report() {
  return <Instruction>Summarize the problem in two sentences: what happened, and what the caller needs.</Instruction>;
}
