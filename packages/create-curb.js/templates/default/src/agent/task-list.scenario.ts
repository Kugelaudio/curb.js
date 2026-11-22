import { scenario } from "curb/testing";
import type { Task } from "./agent.js";

/**
 * Scripted caller lines: the same words on every run, so this is a gate. It runs once and must
 * pass. Keep one of these for every path that must never break.
 *
 * The task list changes only through its tools, so its state at the end says whether the right
 * tools ran: no check needs to name them.
 */
export default scenario({
  name: "keeps the task list",
  turns: [
    "Put buy milk and call the dentist on my list.",
    "I've called the dentist, that one is done.",
    "What is still open on my list?",
  ],
  expect: ({ state, check, transcript }) => {
    const { tasks } = state<{ tasks: Task[] }>("juno");
    const listed = JSON.stringify(tasks);
    const last = transcript[transcript.length - 1];
    return [
      check("the milk is on the list and still open", tasks.some((task) => task.title.includes("milk") && !task.done), listed),
      check("the dentist call is on the list and done", tasks.some((task) => task.title.includes("dentist") && task.done), listed),
      check("the last reply names the milk", /milk/i.test(last.reply), last.reply),
    ];
  },
});
