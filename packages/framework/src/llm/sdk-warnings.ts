// The AI SDK prints a provider's warnings on every call. The framework asks each Anthropic
// model for its lowest thinking setting (`thinking: disabled`, ai-sdk.ts); a model that
// cannot turn thinking off gets its lowest setting instead, and the provider says so on
// every call (claude-sonnet-5-5: "Using 'between_tools' thinking"). That is the outcome the
// framework asked for, so those warnings are dropped. Every other warning prints once.

type SdkWarning = { type: string; feature?: string; details?: string; message?: string };
type SdkWarningLog = { warnings: readonly SdkWarning[]; provider: string; model: string };

/** The framework's own thinking option: whatever the model does with it is its lowest setting. */
const OWN_THINKING_OPTION = "providerOptions.anthropic.thinking";

/** The AI SDK's own wording (`formatWarning` in `ai`), so a warning reads as it always did. */
function describeWarning(warning: SdkWarning): string {
  const details = warning.details ? ` ${warning.details}` : "";
  switch (warning.type) {
    case "unsupported":
      return `The feature "${warning.feature}" is not supported.${details}`;
    case "compatibility":
      return `The feature "${warning.feature}" is used in a compatibility mode.${details}`;
    case "other":
      return warning.message ?? "";
    default:
      return JSON.stringify(warning);
  }
}

/** An `AI_SDK_LOG_WARNINGS` logger: drops the framework's own thinking warning, prints every
 * other warning once per logger. */
export function createSdkWarningLogger(print: (line: string) => void = console.warn) {
  const printed = new Set<string>();
  return ({ warnings, provider, model }: SdkWarningLog): void => {
    for (const warning of warnings) {
      if (warning.feature === OWN_THINKING_OPTION) continue;
      const line = `AI SDK Warning (${provider} / ${model}): ${describeWarning(warning)}`;
      if (printed.has(line)) continue;
      printed.add(line);
      print(line);
    }
  };
}

/** Install the logger, unless the project set `AI_SDK_LOG_WARNINGS` itself (false, or its own). */
export function quietSdkWarnings(): void {
  const scope = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
  if (scope.AI_SDK_LOG_WARNINGS !== undefined) return;
  scope.AI_SDK_LOG_WARNINGS = createSdkWarningLogger();
}
