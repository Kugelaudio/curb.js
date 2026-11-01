import { readdirSync, readFileSync } from "node:fs";
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

/** The reference pages of a section, by file name. */
function referencePages(section: string): Map<string, string> {
  const directory = fileURLToPath(new URL(`../docs/agent-guide/${section}/`, import.meta.url));
  return new Map(readdirSync(directory).map((name) => [name, readFileSync(`${directory}${name}`, "utf8")]));
}

const kebab = (name: string) => name.replace(/(?<!^)[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();

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

  it.each([
    ["components", /^[A-Z]/, curb],
    ["hooks", /^use[A-Z]/, curb],
  ] as const)("gives every one of the %s a page", (section, shape, entry) => {
    const index = pages(section);
    const names = [...index.matchAll(/^\| \[`(\w+)`\]/gm)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(8);
    expect(names.filter((name) => !shape.test(name) || !(name in entry))).toEqual([]);
    const files = [...referencePages(section).keys()];
    expect(files.sort()).toEqual(names.map((name) => `${kebab(name)}.md`).sort());
  });

  it.each(["components", "hooks", "functions", "providers", "cli"])(
    "gives every page of %s a signature and a version history",
    (section) => {
      const missing = [...referencePages(section)]
        .filter(([, text]) => !/^```/m.test(text) || !/^## Version history\n\n\| Version \| Changes \|/m.test(text))
        .map(([name]) => name);
      expect(missing).toEqual([]);
    },
  );

  it("lists every command of the CLI usage", () => {
    const usage = readFileSync(fileURLToPath(new URL("./cli/main.ts", import.meta.url)), "utf8");
    const block = usage.slice(usage.indexOf("Commands:"), usage.indexOf("`;\n", usage.indexOf("Commands:")));
    const commands = [...block.matchAll(/^ {2}([a-z]+)(?: |$)/gm)].map((match) => match[1]!);

    expect(commands.length).toBeGreaterThan(10);
    const text = pages("cli");
    expect(commands.filter((command) => !text.includes(`\`curb ${command}`))).toEqual([]);
    const files = referencePages("cli");
    expect(commands.filter((command) => ![...files.keys()].some((name) => name.startsWith(command)))).toEqual([]);
  });
});
