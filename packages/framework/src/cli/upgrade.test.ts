import { describe, expect, it } from "vitest";
import { compareVersions, curbDepSpec, isFileSpec, resolveUpgrade, rewriteCurbDep } from "./upgrade.js";

const pkgText = `${JSON.stringify(
  {
    name: "my-agent",
    private: true,
    type: "module",
    scripts: { dev: "curb dev", check: "curb check" },
    dependencies: {
      curb: "https://cdn.kugelaudio.com/curb/curb-0.1.0.tgz",
      react: "^19.2.7",
      "react-dom": "^19.2.7",
    },
  },
  null,
  2,
)}\n`;

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
    expect(curbDepSpec(pkgText)).toBe("https://cdn.kugelaudio.com/curb/curb-0.1.0.tgz");
  });

  it("returns null (no curb dependency) instead of guessing", () => {
    expect(curbDepSpec(JSON.stringify({ dependencies: { react: "^19.2.7" } }))).toBeNull();
  });

  it("detects repo-linked file: specs", () => {
    expect(isFileSpec("file:../curb.js/packages/framework")).toBe(true);
    expect(isFileSpec("https://cdn.kugelaudio.com/curb/curb-0.1.0.tgz")).toBe(false);
  });
});

describe("rewriteCurbDep", () => {
  const spec = "https://cdn.kugelaudio.com/curb/curb-0.2.0.tgz";

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
    expect(text).toBe(pkgText.replace("https://cdn.kugelaudio.com/curb/curb-0.1.0.tgz", spec));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "dependencies": {\n    "curb":');
  });

  it("throws when there is no curb dependency to rewrite", () => {
    expect(() => rewriteCurbDep(JSON.stringify({ dependencies: {} }), spec)).toThrow(/no "curb" dependency/);
  });
});
