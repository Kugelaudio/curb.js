import { describe, expect, it, vi } from "vitest";

import type { CallReporter } from "../../hosted/call-reporter.js";
import { reportTurnEvent } from "./turn-report.js";

describe("a turn's record", () => {
  it("says where a caller got to in a procedure", () => {
    const reporter = { event: vi.fn() } as unknown as CallReporter;
    reportTurnEvent(reporter, { type: "procedure", action: "step_completed", title: "Claim", step: 2, steps: 3, stepTitle: "Evidence" });
    reportTurnEvent(reporter, { type: "procedure", action: "completed", title: "Claim", step: 3, steps: 3 });

    expect(reporter.event).toHaveBeenNthCalledWith(1, "procedure", { action: "step_completed", title: "Claim", step: 2, steps: 3, stepTitle: "Evidence" });
    expect(reporter.event).toHaveBeenNthCalledWith(2, "procedure", { action: "completed", title: "Claim", step: 3, steps: 3 });
  });
});
