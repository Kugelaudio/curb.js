import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  curbDepSpec,
  fetchNpmVersion,
  isFileSpec,
  isNpmSpec,
  notifyIfUpdateAvailable,
  resolveUpgrade,
  rewriteCurbDep,
  runUpgrade,
} from "./upgrade.js";
import { curbVersion } from "../version.js";

const pkgText = `${JSON.stringify(
  {
    name: "my-agent",
    private: true,
    type: "module",
    scripts: { dev: "curb dev", check: "curb check" },
    dependencies: {
      curb: "npm:curb.js@0.1.0",
      react: "^19.2.7",
      "react-dom": "^19.2.7",
    },
  },
  null,
  2,
)}\n`;

const tarball = "https://cdn.example.com/curb/curb-0.1.0.tgz";

describe("compareVersions", () => {
  it("orders numeric segments numerically, not lexicographically", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
  });

  it("treats equal versions as equal, padding missing segments with zero", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("still respects the numeric core across prereleases", () => {
    expect(compareVersions("0.2.0-alpha", "0.1.0")).toBe(1);
  });

  it("orders prereleases by semver precedence, so preview.10 is above preview.9", () => {
    expect(compareVersions("1.15.0-preview.10", "1.15.0-preview.9")).toBe(1);
    expect(compareVersions("1.15.0-preview.2", "1.15.0-preview.2")).toBe(0);
    expect(compareVersions("1.15.0-preview", "1.15.0-preview.1")).toBe(-1);
    expect(compareVersions("1.15.0-1", "1.15.0-preview")).toBe(-1);
    expect(compareVersions("1.15.0-alpha.1", "1.15.0-preview.1")).toBe(-1);
  });
});

describe("resolveUpgrade", () => {
  it("reports up to date for equal versions", () => {
    expect(resolveUpgrade({ current: "0.1.0", latest: "0.1.0" })).toBe("up-to-date");
  });

  it("upgrades when the published version is newer", () => {
    expect(resolveUpgrade({ current: "0.1.0", latest: "0.2.0" })).toBe("upgrade");
    expect(resolveUpgrade({ current: "0.2.0-alpha", latest: "0.2.0" })).toBe("upgrade");
  });

  it("refuses a downgrade when the installed version is ahead of latest", () => {
    expect(resolveUpgrade({ current: "0.3.0", latest: "0.2.0" })).toBe("ahead");
    expect(resolveUpgrade({ current: "0.2.0", latest: "0.2.0-rc.1" })).toBe("ahead");
  });
});

describe("curbDepSpec / isFileSpec", () => {
  it("finds the curb spec in dependencies", () => {
    expect(curbDepSpec(pkgText)).toBe("npm:curb.js@0.1.0");
  });

  it("returns null (no curb dependency) instead of guessing", () => {
    expect(curbDepSpec(JSON.stringify({ dependencies: { react: "^19.2.7" } }))).toBeNull();
  });

  it("detects npm alias specs, and nothing else as one", () => {
    expect(isNpmSpec("npm:curb.js@1.15.0")).toBe(true);
    expect(isNpmSpec("npm:curb.js@1.16.0-preview.2")).toBe(true);
    expect(isNpmSpec("npm:curb.js")).toBe(true);
    expect(isNpmSpec("npm:curb.jsx@1.0.0")).toBe(false);
    expect(isNpmSpec(tarball)).toBe(false);
    expect(isNpmSpec("file:../curb.js/packages/framework")).toBe(false);
  });

  it("detects repo-linked file: specs", () => {
    expect(isFileSpec("file:../curb.js/packages/framework")).toBe(true);
    expect(isFileSpec(tarball)).toBe(false);
  });
});

describe("rewriteCurbDep", () => {
  const spec = "npm:curb.js@0.2.0";

  it("rewrites only the curb entry and keeps every other field intact", () => {
    const next = JSON.parse(rewriteCurbDep(pkgText, spec));
    expect(next.dependencies.curb).toBe(spec);
    expect(next.dependencies.react).toBe("^19.2.7");
    expect(next.dependencies["react-dom"]).toBe("^19.2.7");
    expect(next.scripts).toEqual({ dev: "curb dev", check: "curb check" });
    expect(next.name).toBe("my-agent");
  });

  it("preserves key order, 2-space indentation, and the trailing newline", () => {
    const text = rewriteCurbDep(pkgText, spec);
    expect(Object.keys(JSON.parse(text).dependencies)).toEqual(["curb", "react", "react-dom"]);
    expect(text).toBe(pkgText.replace("npm:curb.js@0.1.0", spec));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "dependencies": {\n    "curb":');
  });

  it("throws when there is no curb dependency to rewrite", () => {
    expect(() => rewriteCurbDep(JSON.stringify({ dependencies: {} }), spec)).toThrow(/no "curb" dependency/);
  });
});

describe("where a project's upgrade reads from", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project depending on curb through `spec`, a fake network, and what it was asked. */
  function project(spec: string, routes: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "curb-upgrade-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { curb: spec } }));
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      const body = routes[url];
      return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
    });
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    return { dir, asked, logged };
  }

  const distTags = "https://registry.npmjs.org/-/package/curb.js/dist-tags";
  const newest = "999.0.0";

  it("a project on the npm alias reads npm's latest", async () => {
    const { dir, asked, logged } = project("npm:curb.js@1.0.0", { [distTags]: { latest: newest } });
    await runUpgrade(["--check"], dir);
    expect(asked).toEqual([distTags]);
    expect(logged.join("\n")).toContain(`v${newest} is available. Run \`curb upgrade\` to update.`);
  });

  it("--preview reads the preview dist-tag and says the command that installs it", async () => {
    const preview = `${newest}-preview.2`;
    const { dir, logged } = project("npm:curb.js@1.0.0", { [distTags]: { latest: "0.0.1", preview } });
    await runUpgrade(["--check", "--preview"], dir);
    expect(logged.join("\n")).toContain(`v${preview} is available. Run \`curb upgrade --preview\` to update.`);
  });

  it("a project on a preview stays on it until a newer stable release is out", async () => {
    const { dir, logged } = project("npm:curb.js@1.0.0", { [distTags]: { latest: "0.0.1" } });
    await runUpgrade(["--check"], dir);
    expect(logged.join("\n")).toContain(`Installed curb v${curbVersion()} is newer`);
  });

  it("a project on a tarball URL stops with the npm command, and asks nothing", async () => {
    const { dir, asked } = project(tarball, {});
    const failure = runUpgrade([], dir);
    await expect(failure).rejects.toThrow(tarball);
    await expect(failure).rejects.toThrow(/"npm:curb\.js@<version>" by running `npm install curb@npm:curb\.js@latest`/);
    expect(asked).toEqual([]);
  });

  it("--check and --preview stop the same way, and --preview names the preview tag", async () => {
    const { dir, asked } = project(tarball, {});
    await expect(runUpgrade(["--check"], dir)).rejects.toThrow(/npm install curb@npm:curb\.js@latest/);
    await expect(runUpgrade(["--preview"], dir)).rejects.toThrow(/npm install curb@npm:curb\.js@preview/);
    expect(asked).toEqual([]);
  });

  it("a dependency that is neither npm's alias nor file: stops too", async () => {
    const { dir, asked } = project("*", {});
    await expect(runUpgrade([], dir)).rejects.toThrow(/dependency is \*/);
    expect(asked).toEqual([]);
  });

  it("the update notice reads npm's latest for a project on the npm alias", async () => {
    const { dir, asked, logged } = project("npm:curb.js@1.0.0", { [distTags]: { latest: newest } });
    notifyIfUpdateAvailable(dir);
    await vi.waitFor(() => expect(logged.join("\n")).toContain(`v${newest} — run \`curb upgrade\``));
    expect(asked).toEqual([distTags]);
  });

  it("the update notice asks nothing for a project outside npm", async () => {
    const { dir, asked, logged } = project(tarball, {});
    notifyIfUpdateAvailable(dir);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("a repo-linked project is left alone, with --preview too", async () => {
    const { dir, asked, logged } = project("file:../curb.js/packages/framework", {});
    await runUpgrade(["--preview"], dir);
    expect(asked).toEqual([]);
    expect(logged.join("\n")).toContain("repo checkout");
  });

  it("CURB_NPM_REGISTRY points at a mirror", async () => {
    vi.stubEnv("CURB_NPM_REGISTRY", "https://mirror.example/npm/");
    const url = "https://mirror.example/npm/-/package/curb.js/dist-tags";
    const { dir, asked } = project("npm:curb.js@1.0.0", { [url]: { latest: newest } });
    await runUpgrade(["--check"], dir);
    expect(asked).toEqual([url]);
  });

  it("names the channel when npm has no such dist-tag", async () => {
    project("npm:curb.js@1.0.0", { [distTags]: { latest: "1.0.0" } });
    await expect(fetchNpmVersion("https://registry.npmjs.org", "preview")).rejects.toThrow(/no "preview" release/);
  });
});
