/**
 * The speech-to-speech model the eval's agents run on, from the environment, so the same agents
 * measure any model that speaks the OpenAI Live protocol:
 *
 *   S2S_BASE_URL   the endpoint, e.g. https://api.example.com/v1
 *   S2S_MODEL      the model id the endpoint expects
 *   S2S_API_KEY    its key (read by Curb when a call starts, never here)
 *   S2S_VOICE      optional voice id
 *   S2S_VERBATIM   1: the model says Curb's replies as written, and the caller's answer to a
 *                  question from Curb always goes back to Curb (`openai.live({ verbatim: true })`)
 *
 * Without S2S_BASE_URL the agents have no `s2s` and run cascaded, on their `llm` alone.
 * `language` is the agent's own: the language its calls are in.
 */

import { openai, type S2sDescriptor } from "curb/providers";

export function modelUnderTest(language: string): S2sDescriptor | undefined {
  const baseURL = process.env.S2S_BASE_URL?.trim();
  if (!baseURL) return undefined;
  const model = process.env.S2S_MODEL?.trim();
  const voice = process.env.S2S_VOICE?.trim();
  return openai.live({
    baseURL,
    apiKeyEnv: "S2S_API_KEY",
    language,
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(process.env.S2S_VERBATIM === "1" ? { verbatim: true } : {}),
  });
}
