import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * `curb test` and `curb review` are built on the public `curb/testing` entry, as anyone's own
 * tests are: the two commands, and every module of the CLI they import in turn, reach testing
 * code only through `src/testing/index.ts`. If one of them needs something that entry does not
 * export, the foundation is missing it: add it there, with its docs, rather than importing past it.
 */
const src = resolve(fileURLToPath(import.meta.url), "../..");
const testing = resolve(src, "testing");

/** Every module a file imports, by its path under `src/`, `.js` read as the `.ts` beside it. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+)";/gms)].map((match) => {
    const target = resolve(dirname(file), match[1]!);
    return [target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx")].find(existsSync) ?? target;
  });
}

it("curb test and curb review import testing code only from curb/testing", () => {
  const cli = resolve(src, "cli");
  const seen = new Set<string>();
  const past: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const target of importsOf(file)) {
      if (target.startsWith(`${testing}/`) && target !== resolve(testing, "index.ts")) past.push(`${relative(src, file)} -> ${relative(src, target)}`);
      // The CLI's own modules are followed; the framework beyond them is no testing code.
      else if (target.startsWith(`${cli}/`)) visit(target);
    }
  };
  visit(resolve(cli, "test.ts"));
  visit(resolve(cli, "review.ts"));

  expect([...seen].map((file) => relative(src, file))).toEqual(expect.arrayContaining(["cli/test.ts", "cli/review.ts", "cli/scenarios/run.ts", "cli/scenarios/assess.ts"]));
  expect(past).toEqual([]);
});
