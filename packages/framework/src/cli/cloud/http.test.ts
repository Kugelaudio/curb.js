import { describe, expect, it } from "vitest";
import { cloudError, isHostedAgentsNotEnabled, readErrorBody } from "./http.js";

const request = { method: "POST" as const, url: "https://platform.example/v1/agents/x", webUrl: "https://app.example" };

describe("cloudError", () => {
  it("turns an expired session into a login instruction", () => {
    expect(cloudError(401, { code: "unauthenticated" }, request).message).toBe(
      "Your KugelAudio session expired or was revoked. Run `npx curb login` and try again.",
    );
  });

  it("says the balance is used up in the platform's words, with the code and correlation id", () => {
    const error = cloudError(
      402,
      {
        code: "billing_balance_exhausted",
        category: "billing",
        message: "The organization's balance is used up. Top up the balance to continue.",
        correlationId: "corr-1",
      },
      request,
    );
    expect(error.code).toBe("billing_balance_exhausted");
    expect(error.message).toBe(
      "The organization's balance is used up. Top up the balance to continue. " +
        "(HTTP 402, billing_balance_exhausted, correlation corr-1)",
    );
  });

  it("reads the platform code through the web envelope", () => {
    expect(
      readErrorBody({ error: "Upgrade needed", error_code: "PAYMENT_REQUIRED", details: { platform_code: "upgrade_required", feature: "agents", correlation_id: "c" } }),
    ).toEqual({ code: "upgrade_required", message: "Upgrade needed", feature: "agents", correlationId: "c" });
  });

  // The account sign-in's agent picker and the hosted platform's tenant routes answer an
  // organization without hosted agents in two different envelopes; both read as one refusal
  // with one code.
  it.each([
    [
      "the web app's agents_not_enabled",
      {
        error: "Hosted agents are not enabled for your organization yet. Ask KugelAudio to enable them, then run the command again.",
        error_code: "agents_not_enabled",
        details: { code: "agents_not_enabled" },
        request_id: "req-1",
      },
      "HTTP 403, agents_not_enabled, correlation req-1",
    ],
    [
      "the platform's agents_alpha_required",
      { code: "agents_alpha_required", category: "authorization", retryable: false, message: "authorization failure", correlationId: "corr-2" },
      "HTTP 403, agents_alpha_required, correlation corr-2",
    ],
  ])("says who switches hosted agents on, and that local runs keep working, for %s", (_, body, answered) => {
    const error = cloudError(403, body, request);
    expect(isHostedAgentsNotEnabled(error)).toBe(true);
    expect(error.message).toBe(
      "[CURB_HOSTED_AGENTS_NOT_ENABLED] Hosted agents are not switched on for your KugelAudio organization. " +
        `They are in a closed alpha, switched on per organization (${answered}).\n` +
        "Fix: Ask hello@kugelaudio.com to switch them on for your organization, then run the command again. " +
        'Until then the agent runs on this machine as before: `npx curb dev` opens the preview, `npx curb say "<what a caller says>"` runs one turn.',
    );
  });

  it("falls back to the method and path when the body says nothing", () => {
    expect(cloudError(500, null, request).message).toBe("POST /v1/agents/x failed (HTTP 500)");
  });
});
