import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutput,
  fileHashes,
  npmManifest,
  npmNames,
  npmPack,
  npmPageProblems,
  PACKAGES,
  readmeLinks,
  stampTarball,
  unexpectedDifferences,
} from "./npm-package.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_URL = "git+https://github.com/Kugelaudio/curb.js.git";
// What npm needs to show a package page, for a manifest that is not under test.
const PAGE = {
  description: "A framework.",
  keywords: Array.from({ length: 10 }, (_, index) => `keyword-${index}`),
  author: "An author",
  license: "Apache-2.0",
  homepage: "https://curbjs.com",
  bugs: { url: "https://curbjs.com/docs/reporting-a-bug/" },
  repository: { type: "git", url: REPOSITORY_URL, directory: "packages/framework" },
};

test("publishes the framework as curb.js at the stamped version, and leaves the rest alone", () => {
  const manifest = { name: "curb", version: "1.0.0", private: true, bin: { curb: "./bin/curb.js" } };
  const published = npmManifest(manifest, "1.15.0-preview.3");
  assert.equal(published.name, "curb.js");
  assert.equal(published.version, "1.15.0-preview.3");
  assert.deepEqual(published.bin, { curb: "./bin/curb.js" });
  assert.equal("private" in published, false);
});

test("create-curb.js keeps its name", () => {
  const published = npmManifest({ name: "create-curb.js", version: "1.0.1" }, "1.15.0");
  assert.equal(published.name, "create-curb.js");
  assert.equal(published.version, "1.15.0");
});

test("stamps nothing into the npm page: each package.json is the one source", () => {
  assert.deepEqual(npmManifest({ name: "curb", version: "1.0.0" }, "1.15.0"), { name: "curb.js", version: "1.15.0" });
  const published = npmManifest({ name: "curb", version: "1.0.0", ...PAGE }, "1.15.0");
  assert.deepEqual(published, { name: "curb.js", version: "1.15.0", ...PAGE });
});

test("create-curb is create-curb.js under a second name, with a command of that name", () => {
  const manifest = {
    name: "create-curb.js",
    version: "1.0.1",
    description: "Scaffolds",
    bin: { "create-curb.js": "./bin/create-curb.js" },
    files: ["bin"],
  };
  assert.deepEqual(npmNames(manifest), ["create-curb.js", "create-curb", "create-kugelaudio"]);
  const published = npmManifest(manifest, "1.15.0", "create-curb");
  const main = npmManifest(manifest, "1.15.0");
  assert.equal(published.name, "create-curb");
  assert.equal(published.version, "1.15.0");
  assert.deepEqual(published.bin, { "create-curb": "./bin/create-curb.js" });
  assert.deepEqual(main.bin, manifest.bin);
  assert.deepEqual({ ...published, name: main.name, bin: main.bin }, main);
});

test("the framework has one name", () => {
  const manifest = { name: "curb", version: "1.0.0", bin: { curb: "./bin/curb.js" } };
  assert.deepEqual(npmNames(manifest), ["curb.js"]);
  assert.throws(() => npmManifest(manifest, "1.0.0", "create-curb"), /curb is not published as create-curb/);
});

test("curb.js is packed before create-curb.js, which pins it", () => {
  assert.deepEqual(PACKAGES, ["packages/framework", "packages/create-curb.js"]);
});

test("refuses a package Curb does not publish", () => {
  assert.throws(() => npmManifest({ name: "another-package" }, "1.0.0"), /another-package/);
});

test("only package.json may differ after packing", () => {
  const before = new Map([["package.json", "a"], ["bin/curb.js", "b"], ["src/index.ts", "c"]]);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["package.json", "z"]])), []);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["src/index.ts", "z"]])), ["src/index.ts"]);
  const dropped = new Map(before);
  dropped.delete("bin/curb.js");
  assert.deepEqual(unexpectedDifferences(before, dropped), ["bin/curb.js"]);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["extra.txt", "z"]])), ["extra.txt"]);
});

test("leaves no tarball behind when it refuses one", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(release);
  writeFileSync(join(release, "dropped.txt"), "npm pack leaves this out\n");
  writeFileSync(join(release, "kept.txt"), "kept\n");
  const manifest = { name: "curb", version: "1.0.0", private: true, files: ["kept.txt"] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  assert.throws(() => stampTarball(join(work, "release.tgz"), out, { version: "9.9.9" }), /dropped\.txt/);
  assert.deepEqual(readdirSync(out), []);
});

test("names build output under .curb/, and nothing that only looks like it", () => {
  const paths = ["src/test-fixtures/project/.curb/build/hosted-entry.mjs", "src/curb.ts", "docs/.curbish/a.md"];
  assert.deepEqual(buildOutput(paths), ["src/test-fixtures/project/.curb/build/hosted-entry.mjs"]);
});

test("refuses a tarball that carries build output, and leaves nothing behind", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(join(release, ".curb"), { recursive: true });
  writeFileSync(join(release, ".curb", "entry.mjs"), "generated\n");
  const manifest = { name: "curb", version: "1.0.0", private: true, files: [".curb"] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  assert.throws(() => stampTarball(join(work, "release.tgz"), out, { version: "9.9.9" }), /build output: \.curb/);
  assert.deepEqual(readdirSync(out), []);
});

test("one packed tarball stamps into both create names, the same but for package.json", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "bin/create-curb.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(release, "README.md"), "# create-curb.js\n");
  const manifest = {
    name: "create-curb.js",
    version: "1.0.1",
    bin: { "create-curb.js": "./bin/create-curb.js" },
    files: ["bin"],
    ...PAGE,
  };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  for (const name of npmNames(manifest)) stampTarball(join(work, "release.tgz"), out, { version: "1.15.0", name });
  assert.deepEqual(readdirSync(out).sort(), [
    "create-curb-1.15.0.tgz",
    "create-curb.js-1.15.0.tgz",
    "create-kugelaudio-1.15.0.tgz",
  ]);
  const unpacked = (file) => {
    const directory = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
    execFileSync("tar", ["-xzf", join(out, file), "-C", directory]);
    return join(directory, "package");
  };
  const main = unpacked("create-curb.js-1.15.0.tgz");
  for (const name of ["create-curb", "create-kugelaudio"]) {
    const other = unpacked(`${name}-1.15.0.tgz`);
    assert.deepEqual(unexpectedDifferences(fileHashes(main), fileHashes(other)), []);
    const manifest = JSON.parse(readFileSync(join(other, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    assert.deepEqual(Object.keys(manifest.bin), [name]);
  }
});

test("each package names the repository trusted publishing checks, and its own directory", () => {
  for (const directory of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
    assert.equal(manifest.repository.url, REPOSITORY_URL);
    assert.equal(manifest.repository.directory, directory);
  }
});

test("finds links and images in markdown and HTML, and none in code", () => {
  const readme = [
    '<a href="https://a.example"><img src="https://b.example/c.png"></a>',
    '<source srcset="logo.svg">',
    "[docs](https://d.example) ![shot](assets/e.png)",
    "```tsx",
    '<Tool href="in-code" />',
    "```",
  ].join("\n");
  assert.deepEqual(readmeLinks(readme), ["https://a.example", "https://b.example/c.png", "logo.svg", "https://d.example", "assets/e.png"]);
});

test("a complete package has nothing missing from its npm page", () => {
  assert.deepEqual(npmPageProblems(PAGE, "# Curb\n\n[Docs](https://curbjs.com/docs/) and [more](#more)\n"), []);
});

test("names every field a package page would lose", () => {
  for (const field of ["description", "author", "license", "homepage", "bugs"]) {
    const { [field]: _dropped, ...manifest } = PAGE;
    assert.deepEqual(npmPageProblems(manifest, "# Curb\n"), [`no ${field}`]);
  }
  const { repository, ...withoutRepository } = PAGE;
  assert.deepEqual(npmPageProblems(withoutRepository, "# Curb\n"), ["no repository with a directory"]);
  const noDirectory = { ...PAGE, repository: { type: "git", url: repository.url } };
  assert.deepEqual(npmPageProblems(noDirectory, "# Curb\n"), ["no repository with a directory"]);
});

test("wants a real set of keywords", () => {
  const { keywords: _keywords, ...none } = PAGE;
  assert.deepEqual(npmPageProblems(none, "# Curb\n"), ["0 keywords, expected 10 to 15"]);
  const tooMany = Array.from({ length: 16 }, (_, index) => `keyword-${index}`);
  assert.deepEqual(npmPageProblems({ ...PAGE, keywords: tooMany }, "# Curb\n"), ["16 keywords, expected 10 to 15"]);
});

test("wants a README, with links that open on npm", () => {
  assert.deepEqual(npmPageProblems(PAGE, undefined), ["no README.md"]);
  assert.deepEqual(npmPageProblems(PAGE, "  \n"), ["no README.md"]);
  const links = [
    "LICENSE",
    "http://curbjs.com/",
    "https://raw.githubusercontent.com/Kugelaudio/curb.js/main/a.png",
    "https://github.com/Kugelaudio/curb.js/blob/main/LICENSE",
  ];
  assert.deepEqual(
    npmPageProblems(PAGE, links.map((link) => `[link](${link})`).join("\n")),
    links.map((link) => `a README.md link npm cannot show: ${link}`),
  );
});

test("refuses a tarball that would lose its npm page, and leaves nothing behind", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(release);
  writeFileSync(join(release, "kept.txt"), "kept\n");
  const manifest = { name: "curb", version: "1.0.0", private: true, files: ["kept.txt"], ...PAGE, keywords: [] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  assert.throws(
    () => stampTarball(join(work, "release.tgz"), out, { version: "9.9.9" }),
    /curb\.js would lose its npm page: 0 keywords, expected 10 to 15, no README\.md/,
  );
  assert.deepEqual(readdirSync(out), []);
});

const SHIPPED = {
  "packages/framework": ["LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md", "bin", "docs", "index.html", "package.json", "src"],
  "packages/create-curb.js": ["LICENSE", "NOTICE", "README.md", "bin", "package.json", "templates"],
};

for (const directory of PACKAGES) {
  const source = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
  for (const name of npmNames(source)) {
    test(`${directory} packs as ${name} with its whole npm page, and nothing extra at its top level`, () => {
      const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
      const tarball = stampTarball(npmPack(join(ROOT, directory)), work, { version: "1.15.0", name });
      const unpacked = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
      execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
      const packed = join(unpacked, "package");

      assert.deepEqual(readdirSync(packed).sort(), SHIPPED[directory]);
      const manifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
      assert.equal(manifest.name, name);
      assert.deepEqual(npmPageProblems(manifest, readFileSync(join(packed, "README.md"), "utf8")), []);
      assert.equal(new Set(manifest.keywords).size, manifest.keywords.length);
      assert.equal(manifest.homepage, "https://curbjs.com");
      assert.equal(manifest.repository.directory, directory);
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal("private" in manifest, false);
    });
  }
}

test("stamps the version into the tarball and ships the release notes", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(release);
  writeFileSync(join(release, "kept.txt"), "kept\n");
  writeFileSync(join(release, "README.md"), "# Curb\n");
  const manifest = { name: "curb", version: "1.0.0", private: true, files: ["kept.txt"], ...PAGE };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  writeFileSync(join(work, "notes.md"), "## Added\n");
  const out = join(work, "out");
  mkdirSync(out);

  const tarball = stampTarball(join(work, "release.tgz"), out, { version: "1.15.0", notes: join(work, "notes.md") });
  assert.equal(readdirSync(out)[0], "curb.js-1.15.0.tgz");
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
  const stamped = JSON.parse(readFileSync(join(unpacked, "package/package.json"), "utf8"));
  assert.equal(stamped.name, "curb.js");
  assert.equal(stamped.version, "1.15.0");
  assert.equal(readFileSync(join(unpacked, "package/RELEASE_NOTES.md"), "utf8"), "## Added\n");
});
