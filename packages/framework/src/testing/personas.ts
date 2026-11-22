import type { CallerPersona } from "./scenario.js";

/**
 * A small library of callers for `scenario({ caller })`. A simulated caller is more patient,
 * clearer and more cooperative than the people who call, so an agent that only meets the plain
 * one is tested on its easiest call. Spread one into the caller:
 *
 *   caller: { goal: "Book a haircut", knows: "Name Alex Example", ...personas.rushed }
 *
 * Each is a `persona` text and the `behaviours` that go with it; write your own the same way.
 */
export const personas = {
  /** Short on time: clipped answers, and pushes back when the agent is slow. */
  rushed: {
    persona: "You are between two meetings and want this done in a minute. You answer in a few words.",
    behaviours: ["impatient"],
  },
  /** Says everything in the first breath, then wanders off the subject once. */
  talkative: {
    persona: "You like to talk and tell the whole story at once, with details nobody asked for.",
    behaviours: ["everything_at_once", "off_topic"],
  },
  /** Not sure what they want: revises a detail after giving it. */
  undecided: {
    persona: "You are not sure what suits you best and think out loud before you settle on something.",
    behaviours: ["changes_mind"],
  },
  /** On a bad line: misses what the agent said and asks for it again. */
  hardOfHearing: {
    persona: "You are calling from a noisy place and do not catch everything the first time.",
    behaviours: ["asks_to_repeat"],
  },
} as const satisfies Record<string, CallerPersona>;
