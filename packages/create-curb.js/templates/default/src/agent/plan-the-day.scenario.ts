import { personas, scenario } from "curb/testing";
import type { Task } from "./agent.js";

/**
 * A simulated caller with a goal: `curb test` plays the caller on a second model, and a judge
 * reads the finished call. The persona makes the caller harder than the default one, who is
 * more patient and clearer than the people who really call.
 *
 * The checks say what must be true when the call is over, not which way the agent took there:
 * a model that asks one question more, or adds the tasks in another order, still passes.
 */
export default scenario({
  name: "plans the day with a talkative caller",
  caller: {
    goal: "Get three tasks onto your list: buy milk, call the dentist, send the invoice.",
    knows: "Your tasks for today: buy milk, call the dentist, send the invoice.",
    ...personas.talkative,
  },
  // A model does not answer the same way twice, so this scenario runs three times and passes
  // when two of the three do. The report still shows the rate and marks it flaky when a run
  // failed. Raise minPassRate toward 1 (every run) once it passes every time for a while;
  // a scripted scenario needs neither: the same words run once and must pass.
  runs: 3,
  minPassRate: 0.66,
  // A judge answers each sentence with yes, no or unknown, and quotes the turn that shows it.
  expectations: ["The agent says a task is on the list only after its add_task call for that task succeeded."],
  // The agent's state at the end of the call: each of the three tasks is on the list, once.
  expect: ({ state, check }) => {
    const titles = state<{ tasks: Task[] }>("juno").tasks.map((task) => task.title);
    const listed = `the list holds: ${titles.join(", ") || "nothing"}`;
    return ["milk", "dentist", "invoice"].map((word) =>
      check(`one task about the ${word} is on the list`, titles.filter((title) => title.includes(word)).length === 1, listed),
    );
  },
});
