/** Voice-friendly punctuation: exclamation marks read as shouting in TTS. */
export function normalizeLlmPunctuation(text: string): string {
  return text.replace(/!/g, ".");
}
