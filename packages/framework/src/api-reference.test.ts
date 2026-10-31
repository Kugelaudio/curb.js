import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as client from "./client/index.js";
import * as curb from "./index.js";
import * as providers from "./providers.js";
import * as testing from "./testing/index.js";

/** The text of these API Reference pages. */
function pages(...names: string[]): string {
  return names
    .map((name) => readFileSync(fileURLToPath(new URL(`../docs/agent-guide/${name}.md`, import.meta.url)), "utf8"))
    .join("\n");
}

describe("the API reference", () => {
  it.each([
    ["curb", curb, ["components", "hooks", "functions"]],
    ["curb/providers", providers, ["providers"]],
    ["curb/client", client, ["client"]],
    ["curb/testing", testing, ["testing-api"]],
  ] as const)("lists every runtime export of %s", (_entry, entry, names) => {
    const text = pages(...names);
    expect(Object.keys(entry).filter((name) => !text.includes(`\`${name}\``))).toEqual([]);
  });

  it("lists every command of the CLI usage", () => {
    const usage = readFileSync(fileURLToPath(new URL("./cli/main.ts", import.meta.url)), "utf8");
    const block = usage.slice(usage.indexOf("Commands:"), usage.indexOf("`;\n", usage.indexOf("Commands:")));
    const commands = [...block.matchAll(/^ {2}([a-z]+)(?: |$)/gm)].map((match) => match[1]!);

    expect(commands.length).toBeGreaterThan(10);
    const text = pages("cli");
    expect(commands.filter((command) => !text.includes(`\`curb ${command}`))).toEqual([]);
  });
});
