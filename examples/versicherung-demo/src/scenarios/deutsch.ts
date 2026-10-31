import type { ScenarioTurn } from "curb/testing";

const ENGLISCH = /\b(the|you|your|please|could|help|thanks|sorry|first)\b/i;

/** The agent's replies that read as English. A German agent has none. */
export function englischeAntworten(transcript: readonly ScenarioTurn[]): string[] {
  return transcript.map((turn) => turn.reply).filter((reply) => ENGLISCH.test(reply));
}
