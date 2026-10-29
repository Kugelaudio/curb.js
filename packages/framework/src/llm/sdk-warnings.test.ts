import { afterEach, describe, expect, it } from "vitest";
import { createSdkWarningLogger, quietSdkWarnings } from "./sdk-warnings.js";

const scope = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };

afterEach(() => {
  delete scope.AI_SDK_LOG_WARNINGS;
});

describe("createSdkWarningLogger", () => {
  it("drops the framework's own thinking option and prints any other warning once", () => {
    const lines: string[] = [];
    const log = createSdkWarningLogger((line) => lines.push(line));
    const call = {
      provider: "anthropic.messages",
      model: "claude-sonnet-5-5",
      warnings: [
        {
          type: "unsupported",
          feature: "providerOptions.anthropic.thinking",
          details: "thinking cannot be disabled for claude-sonnet-5-5. Using 'between_tools' thinking, the lowest thinking setting, instead.",
        },
        { type: "unsupported", feature: "temperature", details: "Remove it." },
      ],
    };
    log(call);
    log(call);
    log({ ...call, warnings: [{ type: "other", message: "Something else." }] });

    expect(lines).toEqual([
      'AI SDK Warning (anthropic.messages / claude-sonnet-5-5): The feature "temperature" is not supported. Remove it.',
      "AI SDK Warning (anthropic.messages / claude-sonnet-5-5): Something else.",
    ]);
  });
});

describe("quietSdkWarnings", () => {
  it("installs the logger once and leaves a project's own setting alone", () => {
    quietSdkWarnings();
    const installed = scope.AI_SDK_LOG_WARNINGS;
    expect(typeof installed).toBe("function");
    quietSdkWarnings();
    expect(scope.AI_SDK_LOG_WARNINGS).toBe(installed);

    scope.AI_SDK_LOG_WARNINGS = false;
    quietSdkWarnings();
    expect(scope.AI_SDK_LOG_WARNINGS).toBe(false);
  });
});
