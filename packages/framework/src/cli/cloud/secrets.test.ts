import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudClient } from "./client.js";
import { type FakeCloud, fakeCredentials, startFakeCloud } from "./fake-cloud.test-support.js";
import { parseDotenv, pushSecrets } from "./secrets.js";

describe("parseDotenv", () => {
  it("reads comments, export, quotes, escapes, inline comments and multi-line values", () => {
    const text = [
      "# provider keys",
      "",
      "export ANTHROPIC_API_KEY=sk-ant-123",
      "AZURE_SPEECH_REGION = westeurope # EU",
      "SINGLE='literal \\n # not a comment'",
      'DOUBLE="line1\\nline2 \\"quoted\\""',
      'PEM="-----BEGIN-----',
      "abc",
      '-----END-----"',
      "EMPTY=",
      "DUP=first",
      "DUP=second",
    ].join("\r\n");
    expect(parseDotenv(text)).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-123", line: 3 },
      { name: "AZURE_SPEECH_REGION", value: "westeurope", line: 4 },
      { name: "SINGLE", value: "literal \\n # not a comment", line: 5 },
      { name: "DOUBLE", value: 'line1\nline2 "quoted"', line: 6 },
      { name: "PEM", value: "-----BEGIN-----\nabc\n-----END-----", line: 7 },
      { name: "EMPTY", value: "", line: 10 },
      { name: "DUP", value: "second", line: 12 },
    ]);
  });

  it("refuses a line that is not an assignment, and an unclosed quote", () => {
    expect(() => parseDotenv("JUST_A_WORD")).toThrow(".env line 1 is not NAME=value.");
    expect(() => parseDotenv('KEY="open')).toThrow(/never closed/);
  });
});

describe("pushSecrets", () => {
  let cloud: FakeCloud;
  let dir: string;
  const link = { webUrl: "", orgId: "org-a", projectId: "p", agentId: "a", platformProjectId: "pp", environmentId: "env-1", dashboardUrl: "" };

  beforeEach(async () => {
    cloud = await startFakeCloud();
    dir = mkdtempSync(join(tmpdir(), "curb-secrets-"));
  });

  afterEach(async () => {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets each variable on the production environment, skips platform-owned ones, and never prints a value", async () => {
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "ANTHROPIC_API_KEY=sk-ant-secret-value",
        "AZURE_SPEECH_KEY=azure-secret-value",
        "KUGELAUDIO_API_KEY=ka-secret",
        "KUGELAUDIO_API_BASE=https://api.example",
        "LIVEKIT_API_SECRET=lk-secret",
        "OPTIONAL=",
      ].join("\n"),
    );
    cloud.route("POST /v1/agents/environments/env-1/secrets", (request) => {
      const { name } = request.json() as { name: string };
      return { status: name === "ANTHROPIC_API_KEY" ? 201 : 200, body: { name, updatedAt: "2026-10-16T00:00:00Z" } };
    });
    const lines: string[] = [];

    const result = await pushSecrets({ client: new CloudClient(fakeCredentials(cloud.url)), link, file, log: (line) => lines.push(line) });

    expect(result.set).toEqual(["ANTHROPIC_API_KEY", "AZURE_SPEECH_KEY"]);
    expect(result.skipped.map((entry) => entry.name)).toEqual(["KUGELAUDIO_API_KEY", "KUGELAUDIO_API_BASE", "LIVEKIT_API_SECRET", "OPTIONAL"]);
    expect(cloud.requests.map((request) => request.json())).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret-value" },
      { name: "AZURE_SPEECH_KEY", value: "azure-secret-value" },
    ]);
    for (const request of cloud.requests) {
      expect(request.headers["x-kugel-tenant"]).toBe("org-a");
      expect(request.headers["idempotency-key"]).toBeTruthy();
    }
    expect(lines.slice(0, 2)).toEqual(["  ANTHROPIC_API_KEY set", "  AZURE_SPEECH_KEY replaced"]);
    const output = lines.join("\n");
    for (const secret of ["sk-ant-secret-value", "azure-secret-value", "ka-secret", "lk-secret"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("refuses an invalid name before sending anything", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, "GOOD=1\n1BAD=2\n");
    await expect(
      pushSecrets({ client: new CloudClient(fakeCredentials(cloud.url)), link, file, log: () => {} }),
    ).rejects.toThrow(/1BAD \(line 2\) is not a valid variable name.*Nothing was pushed/);
    expect(cloud.requests).toHaveLength(0);
  });

  it("names what was already pushed when a later set fails, without the value", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, "A=alpha-value\nB=beta-value\n");
    cloud.route("POST /v1/agents/environments/env-1/secrets", (request) => {
      const { name } = request.json() as { name: string };
      return name === "A"
        ? { status: 201, body: { name } }
        : { status: 400, body: { code: "secret_value_too_large", category: "validation", retryable: false, message: "value too large", correlationId: "c1" } };
    });
    const error = await pushSecrets({ client: new CloudClient(fakeCredentials(cloud.url)), link, file, log: () => {} }).catch((e: Error) => e);
    expect((error as Error).message).toBe("Could not set B: value too large (HTTP 400, secret_value_too_large, correlation c1) Already pushed: A.");
    expect((error as Error).message).not.toContain("beta-value");
  });

  it("explains a missing .env", async () => {
    await expect(
      pushSecrets({ client: new CloudClient(fakeCredentials(cloud.url)), link, file: join(dir, ".env"), log: () => {} }),
    ).rejects.toThrow(/does not exist. Put your provider keys there/);
  });
});
