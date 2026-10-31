import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * What a project can reach: every entry point's exported names and every CLI command. A
 * change to public-api.txt is a change to what projects depend on. Adding a line is a
 * feature; removing or renaming one breaks projects, so it needs `feat(framework)!:`.
 * After a deliberate change, run `npx vitest run --project api -u` and commit the file.
 */
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

function entryPoints(): [string, string][] {
  return Object.entries(manifest.exports)
    .filter(([, file]) => /\.tsx?$/.test(file))
    .map(([name, file]) => [name, resolve(root, file)]);
}

function exportedNames(): string[] {
  const entries = entryPoints();
  const { config } = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(entries.map(([, file]) => file), { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  return entries.flatMap(([name, file]) => {
    const module = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    return checker.getExportsOfModule(module).map((symbol) => `${name} ${symbol.name}`);
  });
}

function cliCommands(): string[] {
  const main = readFileSync(resolve(root, "src/cli/main.ts"), "utf8");
  const table = main.slice(main.indexOf("const commands:"), main.indexOf("const run = command"));
  return [...table.matchAll(/^ {2}(\w+)[,:]/gm)].map((match) => `curb ${match[1]}`);
}

it("the public API changes only on purpose", async () => {
  const lines = [...exportedNames(), ...cliCommands()].sort();
  expect(lines.length).toBeGreaterThan(100);
  await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("public-api.txt");
}, 120_000);
