import { scenario } from "curb/testing";

/**
 * Scripted caller lines: the same words on every run, so this is a gate. It runs once and must
 * pass. Keep one of these for every path that must never break.
 *
 * `curb test --hermetic` (the CI workflow) runs no tool without a fake, so this test fakes the
 * list's tools and checks the calls the agent made: a fake answers in place of the tool, so the
 * list itself stays empty. Each fake answers the way the real tool does.
 */
export default scenario({
  name: "keeps the task list",
  turns: [
    "Put buy milk and call the dentist on my list.",
    "I've called the dentist, that one is done.",
    "What is still open on my list?",
  ],
  fakes: {
    add_task: { ok: true },
    complete_task: (input) => ({ ok: true, message: `Marked "${String(input.title)}" done.` }),
    remove_task: { ok: true, message: "Removed from the list." },
  },
  expect: ({ called, notCalled, check, transcript }) => {
    const last = transcript[transcript.length - 1];
    return [
      called("add_task", { title: /milk/i }),
      called("add_task", { title: /dentist/i }),
      called("complete_task", { title: /dentist/i }),
      notCalled("remove_task"),
      check("the last reply names the milk", /milk/i.test(last.reply), last.reply),
    ];
  },
});
