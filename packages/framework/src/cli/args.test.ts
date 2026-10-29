import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { applyPortFlag, portFlag, rejectUnknownArguments, wantsHelp } from "./args.js";
import { CLOUD_COMMAND_OPTIONS } from "./cloud/commands.js";
import { CliRefusal } from "./refusal.js";

describe("an option a command does not take", () => {
  const refusal = (args: string[], command: keyof typeof CLOUD_COMMAND_OPTIONS) => {
    try {
      rejectUnknownArguments(args, command, CLOUD_COMMAND_OPTIONS[command]);
    } catch (error) {
      return error;
    }
    return null;
  };

  // Onboarding sweep 2026-10-25: a coding agent's first try at a dry run was
  // `curb deploy --dry-run`, answered with only `unknown argument "--dry-run"`.
  it("names the dry runs there are for curb deploy --dry-run, with a stable code", () => {
    const error = refusal(["--dry-run"], "deploy");

    expect(error).toBeInstanceOf(CliRefusal);
    expect((error as CliRefusal).code).toBe("CURB_UNKNOWN_ARGUMENT");
    expect((error as CliRefusal).message).toBe(
      '[CURB_UNKNOWN_ARGUMENT] curb deploy has no option "--dry-run".\n' +
        "Fix: For a dry run, `npx curb deploy --no-activate` builds the new version on the platform and checks " +
        "that it starts while the live version keeps serving, and `npx curb build` builds and starts it on " +
        "this machine without uploading anything. curb deploy takes --agent <id>, --no-activate, --json.",
    );
  });

  it("names the nearest option to a misspelt one", () => {
    expect((refusal(["--noactivate"], "deploy") as Error).message).toBe(
      '[CURB_UNKNOWN_ARGUMENT] curb deploy has no option "--noactivate".\n' +
        "Fix: Did you mean --no-activate? curb deploy takes --agent <id>, --no-activate, --json.",
    );
    expect((refusal(["--fiel=.env.prod"], "secrets push") as Error).message).toContain("Did you mean --file?");
    expect((refusal(["--no-browser"], "login") as Error).message).toBe(
      '[CURB_UNKNOWN_ARGUMENT] curb login has no option "--no-browser".\nFix: curb login takes --url <web>, --no-open.',
    );
    expect((refusal(["--force"], "logout") as Error).message).toBe(
      '[CURB_UNKNOWN_ARGUMENT] curb logout has no option "--force".\nFix: curb logout takes no options.',
    );
  });

  it("takes every option in both value forms", () => {
    expect(refusal(["--agent", "agent-1", "--no-activate"], "deploy")).toBeNull();
    expect(refusal(["--agent=agent-1"], "deploy")).toBeNull();
    expect(refusal(["--file", ".env.prod", "--agent", "a"], "secrets push")).toBeNull();
    expect(refusal(["--no-open", "--url=https://app.example"], "login")).toBeNull();
  });
});

describe("--port", () => {
  it("reads --port <n> and --port=<n>", () => {
    expect(portFlag(["--port", "4100"])).toBe(4100);
    expect(portFlag(["--no-open", "--port=4101"])).toBe(4101);
    expect(portFlag(["--no-open"])).toBeUndefined();
  });

  it("refuses a missing or invalid port with an example", () => {
    expect(() => portFlag(["--port"])).toThrow("--port needs a port number from 1 to 65535. Example: curb dev --port 4100");
    expect(() => portFlag(["--port", "abc"])).toThrow('got "abc"');
    expect(() => portFlag(["--port=70000"])).toThrow('got "70000"');
    expect(() => portFlag(["--port", "0"])).toThrow('got "0"');
  });

  it("sets what the server reads, over values from the project's .env", () => {
    const env: Record<string, string | undefined> = { PORT: "4000", WS_PORT: "5000" };
    expect(applyPortFlag(["--port", "4100"], env)).toBe(4100);
    expect(env).toEqual({ PORT: "4100", WS_PORT: "4100" });

    const untouched: Record<string, string | undefined> = { PORT: "4000" };
    expect(applyPortFlag([], untouched)).toBeUndefined();
    expect(untouched).toEqual({ PORT: "4000" });
  });
});

describe("help", () => {
  const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
  // Not a project: help must work anywhere and must not need one.
  const cwd = mkdtempSync(join(tmpdir(), "curb-help-"));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  function curb(...args: string[]) {
    const env = { ...process.env };
    delete env.AGENT_PROJECT_DIR;
    delete env.TSX_TSCONFIG_PATH;
    return spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  }

  it("recognizes --help and -h anywhere", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["dev", "-h"])).toBe(true);
    expect(wantsHelp(["say", "what does --help do"])).toBe(false);
  });

  it("prints the usage and exits 0 for curb --help, curb help and curb <command> --help", () => {
    for (const args of [["--help"], ["help"], ["dev", "--help"], ["check", "-h"]]) {
      const result = curb(...args);
      expect(result.status, `curb ${args.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Usage: curb <command>");
      expect(result.stdout).toContain("say ");
    }
  }, 120_000);

  // Onboarding dry run 2026-10-26: a fresh coding agent ran `curb whoami`, which curb does not
  // have, and was told only that the command is unknown.
  it("names curb login for curb whoami", () => {
    const result = curb("whoami");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command "whoami". To see or change the KugelAudio account, run `npx curb login`');
  }, 60_000);

  it("prints the say usage for curb say --help", () => {
    const result = curb("say", "--help");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: curb say [--new] [--json] "<what the caller says>"');
  }, 60_000);
});
