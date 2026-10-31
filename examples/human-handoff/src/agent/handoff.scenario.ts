import { scenario } from "curb/testing";

export default scenario({
  name: "offers a callback when nobody answers",
  turns: [
    "I would like to speak to a person please",
    "Yes please call me back on 030 555 0100 about my meter reading",
  ],
  fakes: {
    transfer_call: { ok: false, message: "Nobody answered. Nobody is on the line." },
    request_callback: { ok: true, message: "The callback is recorded." },
  },
  // called() counts a run that succeeded, and this fake fails on purpose: read the transcript.
  expect: ({ called, check, transcript }) => [
    check(
      "tried the transfer first",
      transcript[1]?.toolCalls.some((call) => call.name === "transfer_call") ?? false,
    ),
    called("request_callback"),
  ],
});
