import { describe, expect, it, vi } from "vitest";
import { restoreAgentStores, snapshotAgentStores } from "./agent-state.js";
import { AgentSiteRuntime, Agent, Text, Tool, createAgentStore, useRouter } from "./index.js";

/** One module-level definition — state and actions together, Zustand-style.
 * Explicit generic because the actions READ state (functional set / get) —
 * write-only stores infer on their own. */
type CartStore = {
  items: number;
  addItem: () => void;
  clear: () => void;
};

const useCartStore = createAgentStore<CartStore>("cart", (set, get) => ({
  items: 0,
  addItem: () => set({ items: get().items + 1 }),
  clear: () => set({ items: 0 }),
}));

function CartPage() {
  const { items, addItem, clear } = useCartStore();
  return (
    <agent-page path="/cart" title="Cart">
      <Text>Cart has {String(items)} items.</Text>
      <Tool
        name="add_item"
        description="Add an item to the cart."
        onSubmit={() => {
          addItem();
          return { ok: true };
        }}
      />
      <Tool
        name="clear_cart"
        description="Empty the cart."
        onSubmit={() => {
          clear();
          return { ok: true };
        }}
      />
    </agent-page>
  );
}

function SummaryPage() {
  // Selector form: read one field.
  const items = useCartStore((state) => state.items);
  return (
    <agent-page path="/summary" title="Summary">
      <Text>Summary: {String(items)} items in the cart.</Text>
    </agent-page>
  );
}

function buildRuntime() {
  const runtime = new AgentSiteRuntime(
    <Agent>
      <CartPage />
      <SummaryPage />
    </Agent>,
  );
  runtime.loadSkill("/cart");
  runtime.loadSkill("/summary");
  return runtime;
}

describe("createAgentStore", () => {
  it("shares state and actions across skills — no provider, no keys at call sites", async () => {
    const runtime = buildRuntime();

    let content = runtime.snapshot().context.content.join("\n");
    expect(content).toContain("Cart has 0 items.");
    expect(content).toContain("Summary: 0 items in the cart.");

    // An action captured on ONE page updates BOTH pages.
    await runtime.callTool("add_item", {});
    await runtime.callTool("add_item", {});
    content = runtime.snapshot().context.content.join("\n");
    expect(content).toContain("Cart has 2 items.");
    expect(content).toContain("Summary: 2 items in the cart.");

    await runtime.callTool("clear_cart", {});
    content = runtime.snapshot().context.content.join("\n");
    expect(content).toContain("Cart has 0 items.");
    expect(content).toContain("Summary: 0 items in the cart.");
  });

  it("useRouter().push in a tool handler switches the skill within the SAME call", async () => {
    function IntakePage() {
      const router = useRouter();
      return (
        <agent-page path="/intake" title="Intake">
          <Text>Intake page.</Text>
          <Tool
            name="start_review"
            description="Finish intake and move to review."
            onSubmit={() => {
              router.push("/review");
              return { ok: true, message: "Intake done — review started." };
            }}
          />
        </agent-page>
      );
    }

    const runtime = new AgentSiteRuntime(
      <Agent>
        <IntakePage />
        <agent-page path="/review" title="Review">
          <Text>Review the collected data now.</Text>
        </agent-page>
      </Agent>,
    );
    runtime.loadSkill("/intake");
    expect(runtime.snapshot().context.path).toBe("/intake");

    const outcome = await runtime.callTool("start_review", {});

    // The active skill switched, and the new skill's content arrived AS the
    // tool result's context diff — the model sees it as the call's outcome.
    expect(runtime.snapshot().context.path).toBe("/review");
    expect(runtime.snapshot().context.content.join("\n")).toContain("Review the collected data");
    expect(outcome.contextDiff.join("\n")).toContain("Review the collected data now.");
  });

  it("isolates runtimes: one store definition, one instance PER runtime", async () => {
    // The property that forbids a Zustand-style module singleton: the live
    // session, the inspector shadow, and voice sessions share one process.
    const first = buildRuntime();
    const second = buildRuntime();

    await first.callTool("add_item", {});
    expect(first.snapshot().context.content.join("\n")).toContain("Cart has 1 items.");
    expect(second.snapshot().context.content.join("\n")).toContain("Cart has 0 items.");
  });
});

type Task = { title: string; done: boolean };
type TaskStore = { tasks: Task[]; tags?: string[]; add: (title: string) => void };

const useTasks = createAgentStore<TaskStore>("selector-tasks", (set) => ({
  tasks: [],
  add: (title) => set((state) => ({ tasks: [...state.tasks, { title, done: false }] })),
}));

function TaskPage() {
  // Each selector builds a new value on every call; zustand alone loops on all three.
  const tags = useTasks((state) => state.tags ?? []);
  const counts = useTasks((state) => ({ total: state.tasks.length, open: state.tasks.filter((task) => !task.done).length }));
  const open = useTasks((state) => ({ titles: state.tasks.filter((task) => !task.done).map((task) => task.title) }));
  const add = useTasks((state) => state.add);
  return (
    <>
      <Text>{`Tags: ${tags.length}. Tasks: ${counts.total}, open: ${counts.open} (${open.titles.join(", ")}).`}</Text>
      <Tool
        name="add_task"
        description="Add a task."
        onSubmit={() => {
          add("milk");
          return { ok: true };
        }}
      />
    </>
  );
}

describe("store selectors", () => {
  it("render selectors that build a new array or object without looping, and follow changes", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = new AgentSiteRuntime(
      <Agent>
        <TaskPage />
      </Agent>,
    );
    expect(runtime.snapshot().context.content.join("\n")).toContain("Tags: 0. Tasks: 0, open: 0 ().");

    await runtime.callTool("add_task", {});
    expect(runtime.snapshot().context.content.join("\n")).toContain("Tasks: 1, open: 1 (milk).");
    // Not even React's "getSnapshot should be cached" warning.
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("store snapshots (curb say)", () => {
  type Stamp = { label: string; note?: string; at?: Date; update: () => void };
  const useStamp = createAgentStore<Stamp>("stamp", (set) => ({
    label: "initial",
    note: "initial note",
    update: () => set({ label: "updated", note: undefined, at: new Date(0) }),
  }));

  function StampPage() {
    const label = useStamp((state) => state.label);
    const note = useStamp((state) => state.note);
    const update = useStamp((state) => state.update);
    return (
      <>
        <Text>{`Label: ${label}, note: ${note ?? "none"}.`}</Text>
        <Tool
          name="update_stamp"
          description="Update the stamp."
          onSubmit={() => {
            update();
            return { ok: true };
          }}
        />
      </>
    );
  }

  const stampSite = () => (
    <Agent>
      <StampPage />
    </Agent>
  );

  it("carries data fields (and unset ones) into a fresh runtime, naming what JSON cannot carry", async () => {
    const first = new AgentSiteRuntime(stampSite);
    await first.callTool("update_stamp", {});

    const { stores, skipped } = snapshotAgentStores(first);
    expect(stores.stamp).toEqual({ values: { label: "updated" }, unset: ["note"] });
    expect(skipped).toEqual(["stamp.at"]);

    const second = new AgentSiteRuntime(stampSite);
    expect(second.snapshot().context.content.join("\n")).toContain("Label: initial, note: initial note.");
    // Through JSON, as curb say stores it.
    expect(restoreAgentStores(second, JSON.parse(JSON.stringify(stores)))).toEqual([]);
    second.refreshExternal();
    expect(second.snapshot().context.content.join("\n")).toContain("Label: updated, note: none.");
  });

  it("restores a store no component has used yet, and names keys no store defines", async () => {
    const cart = buildRuntime();
    await cart.callTool("add_item", {});
    const { stores } = snapshotAgentStores(cart);

    const stamp = new AgentSiteRuntime(stampSite);
    expect(restoreAgentStores(stamp, { ...stores, "no-such-store": { values: { x: 1 } } })).toEqual([
      "no-such-store",
    ]);
    expect(snapshotAgentStores(stamp).stores.cart).toEqual({ values: { items: 1 } });
  });
});
