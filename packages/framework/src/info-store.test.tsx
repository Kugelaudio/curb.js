import { describe, expect, it, vi } from "vitest";
import {
  AgentSiteRuntime, Agent, Instruction, SystemPrompt, Text, useAgentInfo, useClient, useVariant, type ClientInfo,
} from "./index.js";
import { equalContents } from "./info-context.js";
import { AgentInfoStore } from "./info-store.js";
import { createSemanticRoot } from "./reconciler.js";

function CallerBanner() {
  const phone = useAgentInfo((info) => info["caller.phoneNumber"] as string | undefined);
  return phone ? <Text>Caller phone: {phone}</Text> : null;
}

function infoSite() {
  return (
    <Agent>
      <Text>Welcome.</Text>
      <CallerBanner />
    </Agent>
  );
}

describe("AgentInfoStore", () => {
  it("keeps snapshot identity stable across no-op sets", () => {
    const store = new AgentInfoStore();
    store.set({ a: 1 });
    const before = store.snapshot();
    store.set({ a: 1 });
    expect(store.snapshot()).toBe(before);
  });
});

describe("runtime external info", () => {
  it("exposes info to components and returns the context diff", () => {
    const runtime = new AgentSiteRuntime(infoSite);
    expect(runtime.snapshot().stateSnapshot.join("\n")).not.toContain("Caller phone");

    const diff = runtime.updateInfo({ "caller.phoneNumber": "+49 89 555 0000" });

    expect(diff).toContain("content: Caller phone: +49 89 555 0000");
    expect(runtime.snapshot().stateSnapshot.join("\n")).toContain("+49 89 555 0000");
  });

  it("returns an empty diff when nothing rendered depends on the value", () => {
    const runtime = new AgentSiteRuntime(infoSite);

    const diff = runtime.updateInfo({ "session.abTestBucket": "b" });

    expect(diff).toEqual([]);
    // No context_changed event was recorded for the invisible change.
    const changed = runtime.snapshot().events.filter((event) => event.type === "context_changed");
    expect(changed).toEqual([]);
  });

  it("skips the refresh entirely for a no-op update", () => {
    const runtime = new AgentSiteRuntime(infoSite);
    runtime.updateInfo({ "caller.phoneNumber": "+49 89 555 0000" });

    let notified = 0;
    const unsubscribe = runtime.subscribe(() => {
      notified += 1;
    });
    runtime.updateInfo({ "caller.phoneNumber": "+49 89 555 0000" });
    unsubscribe();

    expect(notified).toBe(0);
  });

  it("renders selectors that build a new array or object without looping", () => {
    function CallerTags() {
      const tags = useAgentInfo((info) => (info["caller.tags"] as string[] | undefined) ?? []);
      const caller = useAgentInfo((info) => ({ phone: info["caller.phoneNumber"] as string | undefined }));
      return <Text>{`Tags: ${tags.join(", ") || "none"}; phone: ${caller.phone ?? "unknown"}.`}</Text>;
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = new AgentSiteRuntime(
      <Agent>
        <CallerTags />
      </Agent>,
    );
    expect(runtime.snapshot().context.content.join("\n")).toContain("Tags: none; phone: unknown.");

    const diff = runtime.updateInfo({ "caller.tags": ["vip"] });
    expect(diff.join("\n")).toContain("Tags: vip; phone: unknown.");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("useClient", () => {
  /** A logged-in caller's page sent its email: the agent stops asking for it. */
  function clientSite(seen: ClientInfo[]) {
    function KnownCaller() {
      const client = useClient();
      seen.push(client);
      const { email, name } = client;
      return email ? (
        <Instruction>{`The caller is ${name ?? "logged in"} with the email address "${email}". Do not ask for it.`}</Instruction>
      ) : null;
    }
    // Where the recipe puts it: inside <Agent>, after <SystemPrompt>.
    return (
      <Agent>
        <SystemPrompt>You are the support line of Example GmbH.</SystemPrompt>
        <KnownCaller />
        <Text>Welcome.</Text>
      </Agent>
    );
  }

  it("reads the page's client.* info without the prefix, text values only", () => {
    const seen: ClientInfo[] = [];
    const runtime = new AgentSiteRuntime(clientSite(seen));
    expect({ ...seen.at(-1) }).toEqual({});

    const diff = runtime.updateInfo({
      "client.email": "max@example.com",
      "client.name": "Max Mustermann",
      "client.seats": 120,
      "caller.phoneNumber": "+49 89 555 0000",
    });

    expect(diff.join("\n")).toContain(
      'The caller is Max Mustermann with the email address "max@example.com". Do not ask for it.',
    );
    const client = seen.at(-1)!;
    expect({ ...client }).toEqual({ email: "max@example.com", name: "Max Mustermann" });
    expect(client.constructor).toBeUndefined();
  });

  it("keeps its object while client.* is unchanged, compared by content", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: ClientInfo[] = [];
    const runtime = new AgentSiteRuntime(clientSite(seen));
    runtime.updateInfo({ "client.email": "max@example.com" });
    const known = seen.at(-1);

    expect(runtime.updateInfo({ "caller.phoneNumber": "+49 89 555 0000" })).toEqual([]);
    expect(seen.at(-1)).toBe(known);

    const diff = runtime.updateInfo({ "client.email": "max.mustermann@example.com" });
    expect(diff.join("\n")).toContain('"max.mustermann@example.com"');
    expect(seen.at(-1)).not.toBe(known);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("names itself when used outside an agent runtime", () => {
    function Probe() {
      useClient();
      return null;
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => createSemanticRoot().render(<Probe />)).toThrow(
      "useClient must be used inside an agent runtime render.",
    );
    logged.mockRestore();
  });
});

describe("useVariant", () => {
  function variantSite(seen: Array<string | undefined>) {
    function Greeting() {
      const greeting = useVariant("greeting");
      seen.push(greeting);
      return greeting === "casual" ? <Instruction>Greet the caller casually.</Instruction> : <Instruction>Greet the caller formally.</Instruction>;
    }
    return (
      <Agent>
        <Greeting />
      </Agent>
    );
  }

  it("reads the call's experiment.<name> info, and undefined for an experiment it has no variant of", () => {
    const seen: Array<string | undefined> = [];
    const runtime = new AgentSiteRuntime(variantSite(seen));
    expect(seen.at(-1)).toBeUndefined();

    const diff = runtime.updateInfo({ "experiment.greeting": "casual", "experiment.pacing": "slow" });
    expect(seen.at(-1)).toBe("casual");
    expect(diff.join("\n")).toContain("Greet the caller casually.");

    runtime.updateInfo({ "experiment.greeting": 1 });
    expect(seen.at(-1)).toBeUndefined();
  });

  it("names itself when used outside an agent runtime", () => {
    function Probe() {
      useVariant("greeting");
      return null;
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => createSemanticRoot().render(<Probe />)).toThrow("useVariant must be used inside an agent runtime render.");
    logged.mockRestore();
  });
});

describe("equalContents", () => {
  it("compares plain data by content and everything else by identity", () => {
    expect(equalContents([], [])).toBe(true);
    expect(equalContents({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(equalContents({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(equalContents([1, 2], [2, 1])).toBe(false);
    expect(equalContents(new Date(5), new Date(5))).toBe(true);
    expect(equalContents(new Map(), new Map())).toBe(false);
    const action = () => {};
    expect(equalContents({ action }, { action })).toBe(true);
    expect(equalContents({ action }, { action: () => {} })).toBe(false);
  });
});
