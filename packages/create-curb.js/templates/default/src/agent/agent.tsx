import {
  Agent,
  GlobalTools,
  Skill,
  Skills,
  SystemPrompt,
  Text,
  Tool,
  createAgentStore,
  defineAgent,
  z,
} from "curb";
import { kugelaudio } from "curb/providers";

/**
 * Juno, the demo assistant of a new project. This file is the agent level, where every
 * conversation starts: her prompt, her day planner (the task list and its tools) and the
 * skills she opens only when needed. Her profile of the user is a markdown file, and wrapping
 * up the day exists as a tool only once a task is done. Replace her with your own agent; the
 * shape (system prompt, skills index, tools, store) stays.
 */

export type Task = { title: string; done: boolean };

export const useAssistant = createAgentStore<{
  tasks: Task[];
  notes: string[];
  addTask: (title: string) => void;
  completeTask: (title: string) => void;
  removeTask: (title: string) => void;
  clearCompleted: () => void;
  remember: (note: string) => void;
}>("juno", (set) => ({
  tasks: [],
  notes: [],
  addTask: (title) =>
    set((state) => {
      const exists = state.tasks.some(
        (task) => task.title.toLowerCase() === title.toLowerCase(),
      );
      if (exists) return state;
      return { tasks: [...state.tasks, { title, done: false }] };
    }),
  completeTask: (title) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.title.toLowerCase() === title.toLowerCase()
          ? { ...task, done: true }
          : task,
      ),
    })),
  removeTask: (title) =>
    set((state) => ({
      tasks: state.tasks.filter(
        (task) => task.title.toLowerCase() !== title.toLowerCase(),
      ),
    })),
  clearCompleted: () =>
    set((state) => ({ tasks: state.tasks.filter((task) => !task.done) })),
  remember: (note) => set((state) => ({ notes: [...state.notes, note] })),
}));

const addSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Short task title, e.g. 'buy milk'. Keep it to a few words."),
});

const completeSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Title of the task to mark done. Match a task from the open list."),
});

const removeSchema = z.object({
  title: z.string().min(1).describe("Title of the task to remove from the list."),
});

/**
 * Juno's day planner, in her context from the first turn. The task list is live state: a tool
 * call updates the store, the component re-renders, and the model's context changes. Watch it
 * in the preview's context inspector while you talk.
 */
function DayPlanner() {
  const tasks = useAssistant((s) => s.tasks);
  const notes = useAssistant((s) => s.notes);
  const addTask = useAssistant((s) => s.addTask);
  const completeTask = useAssistant((s) => s.completeTask);
  const removeTask = useAssistant((s) => s.removeTask);
  const clearCompleted = useAssistant((s) => s.clearCompleted);

  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);

  return (
    <>
      <Text>
        {tasks.length === 0
          ? "No tasks yet."
          : [
              open.length > 0 ? `Open tasks: ${open.map((t) => t.title).join(", ")}.` : null,
              done.length > 0 ? `Done: ${done.map((t) => t.title).join(", ")}.` : null,
            ]
              .filter(Boolean)
              .join(" ")}
      </Text>

      {/* Shared state across skills: the remember tool lives in /about-you,
          but its effect is visible right here. */}
      {notes.length > 0 ? (
        <Text>{`Things I know about the user (remembered this session): ${notes.join("; ")}.`}</Text>
      ) : null}

      <GlobalTools>
        <Tool
          schema={addSchema}
          name="add_task"
          description="Add a task to the user's list for today."
          success="Added to the list."
          onSubmit={(input) => {
            addTask(input.title.toLowerCase());
            return { ok: true };
          }}
        />
        <Tool
          schema={completeSchema}
          name="complete_task"
          description="Mark a task on the list as done."
          onSubmit={(input) => {
            const match = open.find(
              (task) => task.title.toLowerCase() === input.title.toLowerCase(),
            );
            if (!match) {
              return {
                ok: false,
                message: `No open task titled "${input.title}". Retry with a title from the open task list.`,
              };
            }
            completeTask(input.title);
            return { ok: true, message: `Marked "${match.title}" done.` };
          }}
        />
        <Tool
          schema={removeSchema}
          name="remove_task"
          description="Remove a task from the list entirely, done or not."
          onSubmit={(input) => {
            removeTask(input.title);
            return { ok: true, message: "Removed from the list." };
          }}
        />

        {/* Structural gating: wrapping up the day does not exist for the model
            until at least one task is done. No prompt text can route around it. */}
        {done.length > 0 ? (
          <Tool
            name="wrap_up_day"
            description="Wrap up the day: clear the completed tasks and recap what got done."
            onSubmit={() => {
              const count = done.length;
              clearCompleted();
              return {
                ok: true,
                message: `Day wrapped up: ${count} task${count === 1 ? "" : "s"} done and cleared, ${open.length} still open.`,
              };
            }}
          />
        ) : (
          <Text>Wrap-up is locked: the wrap_up_day tool appears once at least one task is marked done.</Text>
        )}
      </GlobalTools>
    </>
  );
}

export function App() {
  // The providers Juno talks through; their keys live in .env. She listens and speaks in
  // English: another language sets `language` on both stt and tts, with a voice that speaks it.
  return (
    <Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts()}>
      <SystemPrompt>{`
        You are Juno, a personal assistant for daily planning and the demo agent of this project.

        You can:
        - keep the user's task list,
        - remember what they tell you about themselves,
        - explain how you are built.

        The task list changes only through its tools: call add_task, complete_task or remove_task first, and say a task is added or done only after the tool answered.

        Greet the user as Juno and tell them that you are an AI assistant.
        Then help them plan their day: offer to keep their task list.
        Mention once that they can ask "how does this work?" to hear how this demo is built.
        Be warm and brief: one or two sentences per reply.
      `}</SystemPrompt>
      {/* Each link's routing description is the target skill's meta.description. */}
      <Skills>
        <Skill path="/about-you">About you</Skill>
        <Skill path="/how-this-works">How this works</Skill>
      </Skills>
      <DayPlanner />
    </Agent>
  );
}

export const agent = defineAgent({
  app: App,
  // Voice calls open with Juno's greeting; "user" waits for the caller instead.
  firstTurn: "agent",
  // Every turn tells the model today's date and time in this zone (default "UTC").
  // timeZone: "Europe/Berlin",
  preview: {
    suggestedPrompts: [
      "Put buy milk on my list",
      "What do you know about me?",
      "Remember that I prefer tea",
      "How does this demo work?",
    ],
    chatPlaceholder: "What's on for today?",
  },
});
