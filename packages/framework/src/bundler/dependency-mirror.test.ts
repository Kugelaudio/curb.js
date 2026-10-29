import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyPackageForTarget,
  findParityViolations,
  listPackageDirs,
  mirrorInstalledDependencies,
  resolveDependencyDir,
} from "./dependency-mirror.js";

/**
 * The trees here are the two shapes that broke real artifacts:
 *
 *   - a package installed with a NESTED dependency whose nested copy the tracer never
 *     reached, so the artifact left it resolving to a different version at the root
 *     (`@opentelemetry/exporter-trace-otlp-proto@0.54` + `otlp-exporter-base@0.208`);
 *   - a package copied WHOLE whose dependency the trace of its main entry never
 *     mentioned, so the artifact has none of it (`@livekit/agents` + `commander@12`).
 */

let root: string;

const writePackage = (dir: string, manifest: Record<string, unknown>, code = "") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "index.js"), code, "utf8");
};

const versionAt = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-mirror-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A source install where `consumer` is pinned to `shared@1.0.0` through a nested copy,
 * while the root holds `shared@2.0.0` for everyone else.
 */
function writeSourceInstall(base: string): void {
  writePackage(join(base, "node_modules", "consumer"), {
    name: "consumer",
    version: "1.0.0",
    dependencies: { shared: "^1.0.0", helper: "^1.0.0" },
    optionalDependencies: { accelerator: "^1.0.0" },
  });
  writePackage(join(base, "node_modules", "consumer", "node_modules", "shared"), {
    name: "shared",
    version: "1.0.0",
  });
  writePackage(join(base, "node_modules", "shared"), { name: "shared", version: "2.0.0" });
  writePackage(join(base, "node_modules", "helper"), {
    name: "helper",
    version: "1.4.0",
    dependencies: { "helper-core": "^1.0.0" },
  });
  writePackage(join(base, "node_modules", "helper-core"), { name: "helper-core", version: "1.1.0" });
  writePackage(join(base, "node_modules", "accelerator"), {
    name: "accelerator",
    version: "1.0.0",
  });
}

describe("resolveDependencyDir", () => {
  it("prefers a nested copy over the hoisted one, like Node", () => {
    const base = join(root, "source");
    writeSourceInstall(base);
    const consumer = join(base, "node_modules", "consumer");
    expect(versionAt(resolveDependencyDir(consumer, base, "shared") as string)).toBe("1.0.0");
    expect(versionAt(resolveDependencyDir(base, base, "shared") as string)).toBe("2.0.0");
  });

  it("never resolves above the given root, so an artifact cannot borrow its host's install", () => {
    const base = join(root, "source");
    writeSourceInstall(base);
    const artifact = join(base, "artifact");
    mkdirSync(artifact, { recursive: true });
    // Node's own resolution from here would walk up into base/node_modules and find it.
    expect(resolveDependencyDir(artifact, artifact, "shared")).toBeUndefined();
  });
});

describe("listPackageDirs", () => {
  it("finds packages at every depth, including nested node_modules", () => {
    const base = join(root, "source");
    writeSourceInstall(base);
    const names = listPackageDirs(base).map((dir) => dir.slice(base.length + 1));
    expect(names).toContain(join("node_modules", "consumer"));
    expect(names).toContain(join("node_modules", "consumer", "node_modules", "shared"));
    expect(names).toContain(join("node_modules", "shared"));
  });
});

describe("copyPackageForTarget", () => {
  it("copies only the ONNX Runtime binaries for the artifact target", async () => {
    const source = join(root, "onnxruntime-node");
    const destination = join(root, "artifact", "node_modules", "onnxruntime-node");
    writePackage(source, { name: "onnxruntime-node", version: "1.29.0" });
    for (const path of [
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "bin/napi-v6/linux/arm64/onnxruntime_binding.node",
      "bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "bin/napi-v6/win32/x64/onnxruntime_binding.node",
    ]) {
      const absolute = join(source, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, path, "utf8");
    }

    await copyPackageForTarget({
      name: "onnxruntime-node",
      source,
      destination,
      target: { os: "linux", architecture: "x64", libc: "gnu" },
    });

    expect(existsSync(join(destination, "bin/napi-v6/linux/x64/onnxruntime_binding.node"))).toBe(true);
    expect(existsSync(join(destination, "bin/napi-v6/linux/arm64"))).toBe(false);
    expect(existsSync(join(destination, "bin/napi-v6/darwin"))).toBe(false);
    expect(existsSync(join(destination, "bin/napi-v6/win32"))).toBe(false);
    expect(existsSync(join(destination, "package.json"))).toBe(true);
  });

  it("prunes ONNX Runtime nested inside a whole-copied native parent", async () => {
    const source = join(root, "agents-plugin-silero");
    const destination = join(root, "artifact", "node_modules", "agents-plugin-silero");
    writePackage(source, { name: "@livekit/agents-plugin-silero", version: "1.5.2" });
    const nested = join(source, "node_modules", "onnxruntime-node");
    writePackage(nested, { name: "onnxruntime-node", version: "1.24.3" });
    for (const path of [
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "bin/napi-v6/win32/x64/onnxruntime_binding.node",
    ]) {
      const absolute = join(nested, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, path, "utf8");
    }

    await copyPackageForTarget({
      name: "@livekit/agents-plugin-silero",
      source,
      destination,
      target: { os: "linux", architecture: "x64", libc: "gnu" },
    });

    const copiedNested = join(destination, "node_modules", "onnxruntime-node");
    expect(existsSync(join(copiedNested, "bin/napi-v6/linux/x64/onnxruntime_binding.node"))).toBe(true);
    expect(existsSync(join(copiedNested, "bin/napi-v6/darwin"))).toBe(false);
    expect(existsSync(join(copiedNested, "bin/napi-v6/win32"))).toBe(false);
    expect(existsSync(join(copiedNested, "package.json"))).toBe(true);
  });
});

describe("mirrorInstalledDependencies", () => {
  it("restores a nested version the trace flattened away", async () => {
    const base = join(root, "source");
    const artifact = join(root, "artifact");
    writeSourceInstall(base);

    // What the tracer produced: consumer's own files, plus the ROOT shared@2.0.0 that
    // some other package pulled in. The nested shared@1.0.0 was never reached.
    writePackage(join(artifact, "node_modules", "consumer"), {
      name: "consumer",
      version: "1.0.0",
      dependencies: { shared: "^1.0.0", helper: "^1.0.0" },
      optionalDependencies: { accelerator: "^1.0.0" },
    });
    writePackage(join(artifact, "node_modules", "shared"), { name: "shared", version: "2.0.0" });
    writePackage(join(artifact, "node_modules", "helper"), {
      name: "helper",
      version: "1.4.0",
      dependencies: { "helper-core": "^1.0.0" },
    });
    writePackage(join(artifact, "node_modules", "helper-core"), {
      name: "helper-core",
      version: "1.1.0",
    });

    const consumer = join(artifact, "node_modules", "consumer");
    expect(versionAt(resolveDependencyDir(consumer, artifact, "shared") as string)).toBe("2.0.0");

    const report = await mirrorInstalledDependencies({
      outDir: artifact,
      base,
      wholeCopied: [],
      target: { os: "linux", architecture: "x64", libc: "gnu" },
    });

    expect(versionAt(resolveDependencyDir(consumer, artifact, "shared") as string)).toBe("1.0.0");
    expect(report.copied).toEqual([
      expect.objectContaining({ name: "shared", version: "1.0.0", reason: "version-mismatch" }),
    ]);
    // Mirrored to its installed position, so the artifact stays a subset of the source.
    expect(report.copied[0].destination).toBe(
      join("node_modules", "consumer", "node_modules", "shared"),
    );
    expect(findParityViolations({ outDir: artifact, base, wholeCopied: [] })).toEqual([]);
  });

  it("completes the closure of a whole-copied package the trace never read", async () => {
    const base = join(root, "source");
    const artifact = join(root, "artifact");
    writeSourceInstall(base);

    // A whole-copied external: all of its files ship, none of its dependencies were
    // traced, so the artifact has the package and nothing it requires.
    writePackage(join(artifact, "node_modules", "consumer"), {
      name: "consumer",
      version: "1.0.0",
      dependencies: { shared: "^1.0.0", helper: "^1.0.0" },
      optionalDependencies: { accelerator: "^1.0.0" },
    });

    const consumer = join(artifact, "node_modules", "consumer");
    const report = await mirrorInstalledDependencies({
      outDir: artifact,
      base,
      wholeCopied: [consumer],
      target: { os: "linux", architecture: "x64", libc: "gnu" },
    });

    expect(versionAt(resolveDependencyDir(consumer, artifact, "shared") as string)).toBe("1.0.0");
    expect(versionAt(resolveDependencyDir(consumer, artifact, "helper") as string)).toBe("1.4.0");
    // Transitive: helper was copied whole in turn, so its own dependency follows.
    const helper = join(artifact, "node_modules", "helper");
    expect(versionAt(resolveDependencyDir(helper, artifact, "helper-core") as string)).toBe("1.1.0");
    // An absent OPTIONAL dependency is left absent: the dependent handles absence, and
    // that is exactly what the trace observed.
    expect(resolveDependencyDir(consumer, artifact, "accelerator")).toBeUndefined();
    expect(report.copied.map((copy) => copy.name).sort()).toEqual([
      "helper",
      "helper-core",
      "shared",
    ]);
  });

  it("leaves a dependency the tracer pruned from a traced package alone", async () => {
    const base = join(root, "source");
    const artifact = join(root, "artifact");
    writeSourceInstall(base);

    // Traced, not whole-copied: an absent dependency is the trace having established
    // that nothing requires it. Filling it back in would undo the pruning.
    writePackage(join(artifact, "node_modules", "consumer"), {
      name: "consumer",
      version: "1.0.0",
      dependencies: { shared: "^1.0.0", helper: "^1.0.0" },
    });

    const report = await mirrorInstalledDependencies({
      outDir: artifact,
      base,
      wholeCopied: [],
      target: { os: "linux", architecture: "x64", libc: "gnu" },
    });

    expect(report.copied).toEqual([]);
    expect(
      resolveDependencyDir(join(artifact, "node_modules", "consumer"), artifact, "helper"),
    ).toBeUndefined();
  });

  it("reports a mismatch it cannot repair rather than shipping it", async () => {
    const base = join(root, "source");
    const artifact = join(root, "artifact");
    writeSourceInstall(base);

    writePackage(join(artifact, "node_modules", "consumer"), {
      name: "consumer",
      version: "1.0.0",
      dependencies: { shared: "^1.0.0" },
    });
    writePackage(join(artifact, "node_modules", "shared"), { name: "shared", version: "2.0.0" });

    const violations = findParityViolations({ outDir: artifact, base, wholeCopied: [] });
    expect(violations).toEqual([
      {
        dependent: join("node_modules", "consumer"),
        dependency: "shared",
        sourceVersion: "1.0.0",
        artifactVersion: "2.0.0",
      },
    ]);
  });
});
