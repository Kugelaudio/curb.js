/**
 * A CLI refusal a person or a coding agent acts on, printed in the shape of an authoring
 * diagnostic (`src/authoring.ts`): a stable code to branch on, what is wrong, and the fix.
 * `main.ts` prints an error's message as it is, so the code and the fix reach the terminal.
 */
export const CLI_REFUSAL_CODES = {
  /** A command was given an option it does not have. */
  unknownArgument: "CURB_UNKNOWN_ARGUMENT",
  /** The signed-in organization does not have hosted agents switched on. */
  hostedAgentsNotEnabled: "CURB_HOSTED_AGENTS_NOT_ENABLED",
  /** `curb deploy --message` was given no summary, or one over the limit. */
  deployMessageInvalid: "CURB_DEPLOY_MESSAGE_INVALID",
} as const;

export type CliRefusalCode = (typeof CLI_REFUSAL_CODES)[keyof typeof CLI_REFUSAL_CODES];

export function formatCliRefusal(code: CliRefusalCode, problem: string, fix: string): string {
  return `[${code}] ${problem}\nFix: ${fix}`;
}

export class CliRefusal extends Error {
  constructor(
    readonly code: CliRefusalCode,
    readonly problem: string,
    readonly fix: string,
  ) {
    super(formatCliRefusal(code, problem, fix));
    this.name = "CliRefusal";
  }
}
