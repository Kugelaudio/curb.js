import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCallEvent } from "../testing/hooks.js";
import { hookCommand, parseHookArgs } from "./hook.js";

describe("parseHookArgs", () => {
  it("reads the hook and its fixture, in either order and either spelling", () => {
    const parsed = { name: "afterCall", file: "call.json" };
    expect(parseHookArgs(["afterCall", "--call", "call.json"])).toEqual(parsed);
    expect(parseHookArgs(["--call", "call.json", "afterCall"])).toEqual(parsed);
    expect(parseHookArgs(["afterCall", "--call=call.json"])).toEqual(parsed);
  });

  it("refuses anything but a hook's name", () => {
    expect(() => parseHookArgs(["--call", "call.json"])).toThrow("name the hook to run: afterCall or afterEvaluation");
    expect(() => parseHookArgs(["afterHours", "--call", "call.json"])).toThrow("name the hook to run");
  });

  it("refuses a run with no fixture", () => {
    expect(() => parseHookArgs(["afterCall"])).toThrow("--call takes the fixture");
    expect(() => parseHookArgs(["afterCall", "--call"])).toThrow("--call takes the fixture");
  });

  it("refuses an option it does not have, naming the one it does", () => {
    expect(() => parseHookArgs(["afterCall", "--cal", "x.json"])).toThrow("Did you mean --call?");
  });
});

describe("hookCommand", () => {
  let root: string;
  const AGENT = `
    export const agent = {
      app: () => null,
      afterCall: async (call, event) => {
        console.log("ran", call.status, event.type);
        if (call.status === "failed") throw new Error("crm down");
      },
    };
  `;

  /** A project with `agent` as its agent, and a fixture holding `fixture`. */
  const project = (agent: string, fixture: unknown): string => {
    mkdirSync(join(root, "src/agent"), { recursive: true });
    writeFileSync(join(root, "src/agent/agent.js"), agent);
    const file = join(root, "fixture.json");
    writeFileSync(file, JSON.stringify(fixture));
    return file;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "curb-hook-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs the hook on a call object, prints how it ended and exits 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = project(AGENT, { status: "completed" });
    await expect(hookCommand(["afterCall", "--call", file], root)).resolves.toBe(0);
    expect(log.mock.calls.map((line) => line.join(" "))).toEqual([
      "ran completed call.ended",
      expect.stringMatching(/^\[afterCall succeeded\] evt_\S+ in \d+ ms$/),
    ]);
  });

  it("runs it on a whole event, and exits 1 with the message when it fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = project(AGENT, buildCallEvent("call.ended", { status: "failed" }));
    await expect(hookCommand(["afterCall", "--call", file], root)).resolves.toBe(1);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/^\[afterCall failed\] evt_\S+ after \d+ ms: crm down$/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("crm down"));
  });

  it("refuses a hook the agent does not declare, saying what to add", async () => {
    const file = project(AGENT, {});
    await expect(hookCommand(["afterEvaluation", "--call", file], root)).rejects.toThrow("declares no afterEvaluation");
  });

  it("refuses a fixture it cannot read, or one that is no call", async () => {
    project(AGENT, {});
    await expect(hookCommand(["afterCall", "--call", join(root, "nope.json")], root)).rejects.toThrow("cannot read the fixture");
    const list = join(root, "list.json");
    writeFileSync(list, "[]");
    await expect(hookCommand(["afterCall", "--call", list], root)).rejects.toThrow("must hold a JSON object");
    const event = project(AGENT, buildCallEvent("call.evaluated"));
    await expect(hookCommand(["afterCall", "--call", event], root)).rejects.toThrow("afterCall receives call.ended");
  });
});
