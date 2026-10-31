import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleAgentDeclarations,
  bundleRequiredSecrets,
  deriveRequiredCapabilities,
  hostNodeMajor,
  RUNTIME_PROTOCOL_VERSION,
} from "./declarations.js";
import type { BundleAsset } from "./assets.js";

/** Whether this Node can stand in for a package a dependency layer lacks (22.15 and later). */
const hasStandIns = "registerHooks" in nodeModule;

let outDir: string;
let projectDir: string;

const writeAsset = (path: string, contents: string): BundleAsset => {
  const absolute = join(outDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
  return { path, kind: "agent-source" };
};

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "curb-declarations-"));
  projectDir = mkdtempSync(join(tmpdir(), "curb-project-declarations-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("bundle declarations", () => {
  it("turns project-declared runtime secret names into manifest requirements", async () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "hosted-agent",
        curb: {
          requiredRuntimeSecrets: ["SPEECH_REGION", "LLM_API_KEY", "SPEECH_REGION"],
        },
      }),
    );

    await expect(bundleRequiredSecrets(projectDir)).resolves.toEqual([
      { name: "LLM_API_KEY", required: true, phase: "runtime" },
      { name: "SPEECH_REGION", required: true, phase: "runtime" },
    ]);
  });

  it("refuses malformed project secret declarations instead of dropping them", async () => {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "broken-agent", curb: { requiredRuntimeSecrets: ["OK", 42] } }),
    );

    await expect(bundleRequiredSecrets(projectDir)).rejects.toThrow(
      /curb\.requiredRuntimeSecrets.*array of non-empty environment variable names/,
    );
  });

  it("declares what every artifact needs, whatever the project is", async () => {
    const asset = writeAsset(
      "assets/agent-source/plain/skill.tsx",
      "export default function Skill() { return <Text>hello</Text>; }",
    );

    // Never empty: the runner grants exactly the declared set, so an empty list is a
    // bundle that cannot reach a model.
    expect(await deriveRequiredCapabilities({ outDir, assets: [asset] })).toEqual([
      "provider.llm",
      "provider.stt",
      "provider.tts",
      "realtime.audio",
    ]);
  });

  it("adds integration.mcp when the project's agent source declares a server", async () => {
    const asset = writeAsset(
      "assets/agent-source/ops/agent.tsx",
      'import { Mcp } from "curb";\nexport default () => <Mcp id="linear" url="https://mcp.linear.app/mcp" />;',
    );

    expect(await deriveRequiredCapabilities({ outDir, assets: [asset] })).toContain(
      "integration.mcp",
    );
  });

  it("ignores context assets, which are markdown rather than declarations", async () => {
    const doc: BundleAsset = { path: "assets/context/notes.md", kind: "context" };
    mkdirSync(join(outDir, "assets", "context"), { recursive: true });
    writeFileSync(join(outDir, doc.path), "The Mcp servers are described here.", "utf8");

    expect(await deriveRequiredCapabilities({ outDir, assets: [doc] })).not.toContain(
      "integration.mcp",
    );
  });

  it("fails rather than deriving a capability set from a source file it cannot read", async () => {
    const absent: BundleAsset = { path: "assets/agent-source/gone.tsx", kind: "agent-source" };
    await expect(deriveRequiredCapabilities({ outDir, assets: [absent] })).rejects.toThrow(
      /cannot read/,
    );
  });
});

describe("the agent's goals and experiments", () => {
  /** An ES module project whose src/agent/agent.ts is `source`, plus `files` beside it. */
  const projectWith = (source: string, files: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "curb-agent-declarations-"));
    const all = { "package.json": '{ "name": "declarations-probe", "private": true, "type": "module" }\n', ...files };
    write(root, { ...all, "src/agent/agent.ts": source });
    return root;
  };
  const write = (root: string, files: Record<string, string>): void => {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents, "utf8");
    }
  };
  const BOOKED = 'export const agent = { app: () => null, goals: { booked: { tool: "book_slot" } } };\n';

  it("finishes when the agent module leaves a timer running at import", async () => {
    const root = projectWith(`setInterval(() => {}, 60_000);\n${BOOKED}`);
    try {
      const started = Date.now();
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).resolves.toMatchObject({
        goals: [{ name: "booked" }],
      });
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("stops an import that never finishes, naming the timeout", async () => {
    const root = projectWith(`await new Promise(() => setInterval(() => {}, 1000));\n${BOOKED}`);
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false, timeoutMs: 4_000 })).rejects.toThrow(
        /importing the agent to read its goals and experiments did not finish within 4 s, so the build stopped it/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads them past packages a dependency layer lacks: ES imports by name, a dependency's require", async () => {
    const root = projectWith(
      [
        'import sharp, { Sharp, format } from "absent-native-image";',
        'import * as addon from "absent-native-addon";',
        'import { Room } from "present-rtc";',
        "export const probe = [sharp().resize(10), new Sharp(), format.jpeg, addon.default, new Room().ffi.FfiClient];",
        BOOKED,
      ].join("\n"),
      {
        // A package that is installed, whose CommonJS build requires one that is not, the way
        // @livekit/rtc-node requires @livekit/rtc-ffi-bindings.
        "node_modules/present-rtc/package.json":
          '{ "name": "present-rtc", "version": "1.0.0", "type": "module", "exports": { ".": { "import": "./index.js", "require": "./index.cjs" } } }\n',
        "node_modules/present-rtc/index.js": 'export * from "./index.cjs";\n',
        "node_modules/present-rtc/index.cjs":
          'const ffi = require("absent-native-ffi");\nexports.Room = class Room { constructor() { this.ffi = ffi; } };\n',
      },
    );
    try {
      const declared = { goals: [{ name: "booked", kind: "tool", tool: "book_slot" }], experiments: [] };
      if (hasStandIns) {
        for (const dependencyLayer of [true, false]) {
          await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer })).resolves.toEqual(declared);
        }
      } else {
        // Nothing stands in, so the layer build escapes, and the full install the builder falls
        // back to has the real packages.
        await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: true })).rejects.toMatchObject({
          code: "layer_escape",
          reason: "unresolved_import",
          path: "absent-native-image",
        });
        write(root, {
          "node_modules/absent-native-image/package.json": '{ "name": "absent-native-image", "type": "module", "main": "index.js" }\n',
          "node_modules/absent-native-image/index.js":
            "export default () => ({ resize() {} });\nexport class Sharp {}\nexport const format = {};\n",
          "node_modules/absent-native-addon/package.json": '{ "name": "absent-native-addon", "type": "module", "main": "index.js" }\n',
          "node_modules/absent-native-addon/index.js": "export default {};\n",
          "node_modules/absent-native-ffi/index.js": "exports.FfiClient = class FfiClient {};\n",
        });
        await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).resolves.toEqual(declared);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("escapes on a dependency-layer build when a stand-in cannot stand in, and fails on a full one", async () => {
    // A string-named import: the names the stub must export are read with a pattern that cannot
    // see it, so the importer fails to link against the stub.
    const root = projectWith(`import { "weird-name" as weird } from "absent-native-image";\nexport const probe = weird;\n${BOOKED}`);
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: true })).rejects.toMatchObject({
        code: "layer_escape",
        reason: "unresolved_import",
        path: "absent-native-image",
        message: expect.stringMatching(
          hasStandIns
            ? /with a stand-in for absent-native-image, which the build inputs lack: .*weird-name/
            : /Node could not resolve it in the build inputs/,
        ),
      });
      // A full install has every package, so there a failure is the project's own.
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).rejects.toThrow(
        hasStandIns
          ? /cannot load the agent in src\/agent\/ to read its goals and experiments: .*weird-name/
          : /cannot load the agent in src\/agent\/ to read its goals and experiments: .*absent-native-image/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("still fails on a file of the project's own that is missing", async () => {
    // Used, so the TypeScript transform keeps the import.
    const root = projectWith(`import { tools } from "./tools.js";\nexport const probe = tools;\n${BOOKED}`);
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).rejects.toThrow(
        /cannot load the agent in src\/agent\/ to read its goals and experiments: .*tools/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads them from the agent module, sorted by name as the manifest carries them", async () => {
    const root = projectWith(`
      export const agent = {
        app: () => null,
        goals: {
          felt_easy: { description: "Booking felt easy", judge: "The caller says booking was easy." },
          booked: { tool: "book_slot" },
        },
        experiments: { greeting: { variants: { formal: 1, casual: 3 }, fromClient: "greeting" } },
      };
    `);
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).resolves.toEqual({
        goals: [
          { name: "booked", kind: "tool", tool: "book_slot" },
          { name: "felt_easy", description: "Booking felt easy", kind: "judge", criterion: "The caller says booking was easy." },
        ],
        experiments: [
          {
            name: "greeting",
            variants: [{ name: "casual", weight: 3 }, { name: "formal", weight: 1 }],
            fromClient: "greeting",
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is two empty lists for an agent that declares neither", async () => {
    const root = projectWith("export const agent = { app: () => null };\n");
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: false })).resolves.toEqual({
        goals: [],
        experiments: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the build, naming the file, when the agent module throws on import", async () => {
    const root = projectWith('throw new Error("goals need a database");\nexport const agent = {};\n');
    try {
      await expect(bundleAgentDeclarations({ projectRoot: root, dependencyLayer: true })).rejects.toThrow(
        /curb build: cannot load the agent in src\/agent\/ to read its goals and experiments: goals need a database/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
