import { scenario } from "curb/testing";

export default scenario({
  name: "offers a callback when nobody can take the call",
  turns: [
    "I would like to speak to a person please",
    "Yes please, my name is Anna Schmidt, call me back on 030 555 0100",
  ],
  // No host dials under curb test, so the handoff reaches nobody and the agent offers a callback.
  expect: ({ called }) => [called("handoff"), called("request_callback")],
});
