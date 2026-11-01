import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudClient } from "./client.js";
import { deploy, deployDescription } from "./deploy.js";
import { type FakeCloud, fakeCredentials, sequence, startFakeCloud } from "./fake-cloud.test-support.js";
import { type Prompter, readLink, reportHostedAgentsAccess, resolveTarget, writeLink } from "./link.js";

let cloud: FakeCloud;
let root: string;
let client: CloudClient;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

// Slugs differ from ids so a URL built from the wrong one fails the test.
const LISTING = {
  orgs: [
    {
      id: "org-a",
      name: "Acme",
      slug: "acme",
      projects: [
        {
          id: "proj-a",
          name: "Support",
          slug: "support",
          agents: [{ id: "agent-a", name: "Juno", slug: "juno", platformProjectId: "pp-a" }],
        },
      ],
    },
    { id: "org-b", name: "Beta", slug: "beta", projects: [{ id: "proj-b", name: "Sales", slug: "sales", agents: [] }] },
  ],
};

function prompter(...answers: string[]): Prompter & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    async ask(question) {
      questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
  };
}

beforeEach(async () => {
  cloud = await startFakeCloud();
  client = new CloudClient(fakeCredentials(cloud.url));
  lines.length = 0;
  root = mkdtempSync(join(tmpdir(), "my-agent-"));
  writeFileSync(join(root, "package.json"), '{"name":"my-agent"}');
  mkdirSync(join(root, "src/agent"), { recursive: true });
  writeFileSync(join(root, "src/agent/agent.tsx"), "export const agent = 1;\n");
  mkdirSync(join(root, "node_modules/react"), { recursive: true });
  writeFileSync(join(root, "node_modules/react/index.js"), "module.exports = 1;");
  writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-never-uploaded\n");
});

afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

function platformCalls() {
  return cloud.requests.filter((request) => request.path.startsWith("/v1/agents/"));
}

describe("resolveTarget", () => {
  it("picks an existing agent, ensures its production environment, and saves the link", async () => {
    cloud.route("GET /api/cli/agents", { body: LISTING });
    cloud.route(
      "GET /v1/agents/projects/pp-a/environments",
      sequence({ body: { environments: [] } }, { body: { environments: [{ id: "env-1", slug: "production", kind: "production" }] } }),
    );
    cloud.route("POST /v1/agents/projects/pp-a/environments", { status: 409, body: { code: "environment_exists", category: "conflict", retryable: false, message: "exists", correlationId: "c" } });
    const ask = prompter("1");

    const link = await resolveTarget({ client, root, prompter: ask, log });

    expect(ask.questions[0]).toContain("1) Acme / Support / Juno");
    expect(ask.questions[0]).toContain("2) Create a new agent");
    expect(link).toEqual({
      webUrl: cloud.url,
      orgId: "org-a",
      projectId: "proj-a",
      agentId: "agent-a",
      platformProjectId: "pp-a",
      environmentId: "env-1",
      dashboardUrl: `${cloud.url}/dashboard/acme/support/agents/juno`,
    });
    expect(readLink(root)).toEqual(link);
    const create = cloud.requests.find((request) => request.method === "POST" && request.path.endsWith("/environments"));
    expect(create?.json()).toEqual({ slug: "production", name: "Production", kind: "production" });
    expect(create?.headers["idempotency-key"]).toBe("production-environment:pp-a");
    for (const call of platformCalls()) {
      expect(call.headers["x-kugel-tenant"]).toBe("org-a");
      expect(call.headers.authorization).toBe("Bearer access-1");
    }
  });

  it("creates a new agent in the chosen project", async () => {
    cloud.route("GET /api/cli/agents", { body: LISTING });
    cloud.route("POST /api/cli/agents", (request) => {
      expect(request.json()).toEqual({ orgId: "org-b", projectId: "proj-b", name: "hotline" });
      return { status: 201, body: { id: "agent-new", name: "hotline", slug: "hotline-2", platformProjectId: "pp-b" } };
    });
    cloud.route("GET /v1/agents/projects/pp-b/environments", { body: { environments: [{ id: "env-b", slug: "production", kind: "production" }] } });

    const link = await resolveTarget({ client, root, prompter: prompter("2", "2", "hotline"), log });
    expect(link.agentId).toBe("agent-new");
    expect(link.orgId).toBe("org-b");
    expect(link.dashboardUrl).toBe(`${cloud.url}/dashboard/beta/sales/agents/hotline-2`);
    expect(platformCalls().every((call) => call.headers["x-kugel-tenant"] === "org-b")).toBe(true);
  });

  it("without a terminal, creates the first agent when there is exactly one project", async () => {
    cloud.route("GET /api/cli/agents", {
      body: { orgs: [{ id: "org-a", name: "Acme", slug: "acme", projects: [{ id: "proj-a", name: "Support", slug: "support", agents: [] }] }] },
    });
    cloud.route("POST /api/cli/agents", { status: 201, body: { id: "agent-new", name: "my-agent", slug: "my-agent", platformProjectId: "pp-a" } });
    cloud.route("GET /v1/agents/projects/pp-a/environments", { body: { environments: [{ id: "env-1", slug: "production", kind: "production" }] } });
    const link = await resolveTarget({ client, root, prompter: null, log });
    expect(link.agentId).toBe("agent-new");
  });

  it("without a terminal, creates the first agent in the project curb login linked, among several", async () => {
    writeLink(root, { webUrl: cloud.url, orgId: "org-b", projectId: "proj-b" });
    cloud.route("GET /api/cli/agents", { body: LISTING });
    cloud.route("POST /api/cli/agents", (request) => {
      expect(request.json()).toEqual({ orgId: "org-b", projectId: "proj-b", name: basename(root) });
      return { status: 201, body: { id: "agent-new", name: "my-agent", slug: "my-agent", platformProjectId: "pp-b" } };
    });
    cloud.route("GET /v1/agents/projects/pp-b/environments", { body: { environments: [{ id: "env-b", slug: "production", kind: "production" }] } });

    const link = await resolveTarget({ client, root, prompter: null, log });

    expect(link).toMatchObject({ orgId: "org-b", projectId: "proj-b", agentId: "agent-new", environmentId: "env-b" });
    expect(readLink(root)).toEqual(link);
  });

  it("offers only the agents of the project curb login linked", async () => {
    writeLink(root, { webUrl: cloud.url, orgId: "org-a", projectId: "proj-a" });
    cloud.route("GET /api/cli/agents", { body: LISTING });
    cloud.route("GET /v1/agents/projects/pp-a/environments", { body: { environments: [{ id: "env-1", slug: "production", kind: "production" }] } });
    const ask = prompter("1");

    const link = await resolveTarget({ client, root, prompter: ask, log });

    expect(ask.questions).toEqual(["Deploy to which agent?\n  1) Acme / Support / Juno\n  2) Create a new agent\n> "]);
    expect(link.agentId).toBe("agent-a");
  });

  it("refuses a linked project the account cannot see, before touching the platform", async () => {
    writeLink(root, { webUrl: cloud.url, orgId: "org-x", projectId: "proj-x" });
    cloud.route("GET /api/cli/agents", { body: LISTING });

    await expect(resolveTarget({ client, root, prompter: null, log })).rejects.toThrow(
      `.curb/link.json names project proj-x, which your account cannot deploy to on ${cloud.url}.`,
    );
    expect(platformCalls()).toHaveLength(0);
  });

  it("refuses a project link to another web URL, before calling anything", async () => {
    writeLink(root, { webUrl: "https://other.example.com", orgId: "org-a", projectId: "proj-a" });

    await expect(resolveTarget({ client, root, prompter: null, log })).rejects.toThrow(
      `This project is linked to https://other.example.com, but you are signed in to ${cloud.url}.`,
    );
    expect(cloud.requests).toHaveLength(0);
  });

  it("without a terminal and with a real choice, refuses and lists --agent ids", async () => {
    cloud.route("GET /api/cli/agents", { body: LISTING });
    await expect(resolveTarget({ client, root, prompter: null, log })).rejects.toThrow(/Pass --agent <id>:\n {2}agent-a {2}Acme \/ Support \/ Juno/);
  });

  it("reuses the saved link without calling anything", async () => {
    writeLink(root, {
      webUrl: cloud.url,
      orgId: "o",
      projectId: "p",
      agentId: "a",
      platformProjectId: "pp",
      environmentId: "e",
      dashboardUrl: `${cloud.url}/dashboard/acme/support/agents/juno`,
    });
    const link = await resolveTarget({ client, root, prompter: null, log });
    expect(link.environmentId).toBe("e");
    expect(cloud.requests).toHaveLength(0);
  });

  it("refuses a link saved before it carried the dashboard URL", async () => {
    mkdirSync(join(root, ".curb"));
    writeFileSync(
      join(root, ".curb", "link.json"),
      JSON.stringify({ webUrl: cloud.url, orgId: "o", projectId: "p", agentId: "a", platformProjectId: "pp", environmentId: "e" }),
    );
    await expect(resolveTarget({ client, root, prompter: null, log })).rejects.toThrow(
      "link.json is missing dashboardUrl. Delete it and run the command again to pick the agent.",
    );
    expect(cloud.requests).toHaveLength(0);
  });

  it("refuses to link when the listing has no slugs, before touching the platform", async () => {
    cloud.route("GET /api/cli/agents", {
      body: { orgs: [{ id: "org-a", name: "Acme", projects: [{ id: "proj-a", name: "Support", agents: [{ id: "agent-a", name: "Juno", platformProjectId: "pp-a" }] }] }] },
    });
    await expect(resolveTarget({ client, root, agentId: "agent-a", prompter: null, log })).rejects.toThrow(
      "answered without the dashboard slugs for Acme / Support / Juno",
    );
    expect(platformCalls()).toHaveLength(0);
    expect(readLink(root)).toBeNull();
  });

  it("says hosted agents are not switched on when the picker's listing is refused, before touching the platform", async () => {
    cloud.route("GET /api/cli/agents", {
      status: 403,
      body: { error: "Hosted agents are not enabled for your organization yet.", error_code: "agents_not_enabled", details: { code: "agents_not_enabled" } },
    });
    await expect(resolveTarget({ client, root, prompter: null, log })).rejects.toThrow(
      /^\[CURB_HOSTED_AGENTS_NOT_ENABLED\] .*closed alpha.*\nFix: Ask hello@kugelaudio\.com .*`npx curb dev`/s,
    );
    expect(platformCalls()).toHaveLength(0);
    expect(readLink(root)).toBeNull();
  });

  it("tells curb login at once when hosted agents are not switched on, and nothing else", async () => {
    cloud.route("GET /api/cli/agents", sequence(
      { status: 403, body: { error: "Hosted agents are not enabled.", error_code: "agents_not_enabled", details: { code: "agents_not_enabled" } } },
      { body: LISTING },
      { status: 500, body: { error: "boom", error_code: "INTERNAL_ERROR" } },
    ));

    await reportHostedAgentsAccess(client, log);
    expect(lines).toEqual([expect.stringMatching(/^\[CURB_HOSTED_AGENTS_NOT_ENABLED\] /)]);

    lines.length = 0;
    await reportHostedAgentsAccess(client, log);
    await reportHostedAgentsAccess(client, log);
    expect(lines).toEqual([]);
  });

  it("maps a plan limit on agent creation to an actionable line", async () => {
    cloud.route("GET /api/cli/agents", { body: LISTING });
    cloud.route("POST /api/cli/agents", {
      status: 402,
      body: { error: "Plan limit", error_code: "PAYMENT_REQUIRED", retryable: false, details: { platform_code: "upgrade_required", feature: "agents" } },
    });
    await expect(resolveTarget({ client, root, prompter: prompter("2", "1", ""), log })).rejects.toThrow(
      `Your plan does not include "agents". Upgrade in ${cloud.url} (Settings > Billing), then run the command again.`,
    );
  });
});

describe("deploy", () => {
  const link = () => ({
    webUrl: cloud.url,
    orgId: "org-a",
    projectId: "proj-a",
    agentId: "agent-a",
    platformProjectId: "pp-a",
    environmentId: "env-1",
    dashboardUrl: `${cloud.url}/dashboard/acme/support/agents/juno`,
  });

  function routeHappyPath() {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", (request) => ({
      status: 201,
      body: {
        uploadObjectKey: "uploads/u1.tar.gz",
        url: `${cloud.url}/store/u1`,
        method: "PUT",
        headers: { "x-amz-checksum-sha256": "c" },
        expiresAt: "2026-10-16T12:00:00Z",
        echo: request.json(),
      },
    }));
    cloud.route("PUT /store/u1", { status: 200 });
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 201, body: { revisionId: "rev-1", deduplicated: false } });
    cloud.route("POST /v1/agents/environments/env-1/activations", { status: 202, body: { state: "pending", buildId: "build-1", operationId: "op-1" } });
    cloud.route("GET /v1/agents/builds/build-1", sequence({ body: { buildId: "build-1", state: "requested" } }, { body: { buildId: "build-1", state: "running" } }, { body: { buildId: "build-1", state: "succeeded" } }));
    cloud.route(
      "GET /v1/agents/environments/env-1/deployments",
      sequence(
        { body: { deployments: [{ deploymentId: "dep-old", revisionId: "rev-1", state: "failed" }] } },
        { body: { deployments: [{ deploymentId: "dep-old", revisionId: "rev-1", state: "failed" }, { deploymentId: "dep-1", revisionId: "rev-1", state: "candidate" }] } },
        { body: { deployments: [{ deploymentId: "dep-old", revisionId: "rev-1", state: "failed" }, { deploymentId: "dep-1", revisionId: "rev-1", state: "active" }] } },
      ),
    );
  }

  it("uploads, captures, activates and polls build then deployment to live", async () => {
    routeHappyPath();
    const result = await deploy({ client, link: link(), root, activate: true, log, pollIntervalMs: 1, sleep: async () => {} });

    const order = cloud.requests.map((request) => `${request.method} ${request.path}`);
    expect(order.slice(0, 6)).toEqual([
      "POST /v1/agents/projects/pp-a/uploads",
      "PUT /store/u1",
      "POST /v1/agents/projects/pp-a/revisions",
      "GET /v1/agents/environments/env-1/deployments",
      "POST /v1/agents/environments/env-1/activations",
      "GET /v1/agents/builds/build-1",
    ]);

    const [uploadRequest, put, capture, , activation] = cloud.requests;
    const digest = `sha256:${createHash("sha256").update(put.body).digest("hex")}`;
    expect(uploadRequest.json()).toEqual({ archiveFormat: "tar.gz", sizeBytes: put.body.length, digest });
    expect(put.headers["x-amz-checksum-sha256"]).toBe("c");
    expect(put.headers.authorization).toBeUndefined();
    expect(capture.json()).toEqual({ adapter: "archive", uploadObjectKey: "uploads/u1.tar.gz", archiveFormat: "tar.gz", uploadDigest: digest });
    expect(activation.json()).toEqual({ revisionId: "rev-1", activate: true });
    for (const call of platformCalls()) {
      expect(call.headers["x-kugel-tenant"]).toBe("org-a");
      if (call.method === "POST") expect(call.headers["idempotency-key"]).toBeTruthy();
    }

    const tar = gunzipSync(put.body);
    expect(tar.includes(Buffer.from("src/agent/agent.tsx"))).toBe(true);
    expect(tar.includes(Buffer.from("node_modules"))).toBe(false);
    expect(tar.includes(Buffer.from("sk-never-uploaded"))).toBe(false);

    // The old failed deployment of the same revision is not mistaken for this one.
    expect(result).toEqual({
      revisionId: "rev-1",
      deploymentId: "dep-1",
      state: "active",
      playgroundUrl: `${cloud.url}/dashboard/acme/support/agents/juno/playground`,
    });
    expect(lines.filter((line) => line.startsWith("  "))).toEqual([
      "  build requested",
      "  build running",
      "  build succeeded",
      "  deployment candidate",
      "  deployment active",
    ]);
    expect(lines.at(-1)).toBe(`Live. Try it in the playground: ${result.playgroundUrl}`);
  });

  it("stops at ready with --no-activate when the platform answers ready", async () => {
    routeHappyPath();
    cloud.route("POST /v1/agents/environments/env-1/activations", { status: 200, body: { state: "ready", deploymentId: "dep-2" } });
    const result = await deploy({ client, link: link(), root, activate: false, log, sleep: async () => {} });
    expect(result.state).toBe("ready");
    expect(cloud.requests.find((request) => request.path.endsWith("/activations"))?.json()).toEqual({ revisionId: "rev-1", activate: false });
    expect(cloud.requests.some((request) => request.path.startsWith("/v1/agents/builds/"))).toBe(false);
  });

  it("reports a failed build with its failure code", async () => {
    routeHappyPath();
    cloud.route("GET /v1/agents/builds/build-1", { body: { buildId: "build-1", state: "failed", failureCode: "build_install_failed" } });
    await expect(
      deploy({ client, link: link(), root, activate: true, log, sleep: async () => {} }),
    ).rejects.toThrow(
      `Build build-1 failed (build_install_failed). Read its log in the dashboard: ${cloud.url}/dashboard/acme/support/agents/juno`,
    );
  });

  it("reports a failed deployment with the platform's reason", async () => {
    routeHappyPath();
    cloud.route(
      "GET /v1/agents/environments/env-1/deployments",
      sequence({ body: { deployments: [] } }, { body: { deployments: [{ deploymentId: "dep-1", revisionId: "rev-1", state: "failed", failure: { code: "readiness_timeout", message: "the worker never started" } }] } }),
    );
    await expect(
      deploy({ client, link: link(), root, activate: true, log, sleep: async () => {} }),
    ).rejects.toThrow("Deployment dep-1 failed (readiness_timeout): the worker never started");
  });

  it("maps source_import_disabled to a one-line fix before anything is uploaded", async () => {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", {
      status: 403,
      body: { code: "source_import_disabled", category: "permission", retryable: false, message: "disabled", correlationId: "corr-1" },
    });
    await expect(
      deploy({ client, link: link(), root, activate: true, log, sleep: async () => {} }),
    ).rejects.toThrow(`Uploading source is not enabled for this organisation. Push the project to GitHub and connect the repository in ${cloud.url} instead.`);
    expect(cloud.requests.some((request) => request.path.startsWith("/store/"))).toBe(false);
  });

  it("sends the description in the revision's body", async () => {
    routeHappyPath();
    await deploy({ client, link: link(), root, activate: true, description: "Greet callers in German", log, pollIntervalMs: 1, sleep: async () => {} });

    const revision = platformCalls().find((request) => request.path === "/v1/agents/projects/pp-a/revisions")!;
    expect(revision.json()).toMatchObject({ adapter: "archive", description: "Greet callers in German" });
    expect(lines).toContain("Revision rev-1.");
  });

  it("leaves the description out of the revision's body when there is none", async () => {
    routeHappyPath();
    await deploy({ client, link: link(), root, activate: true, log, pollIntervalMs: 1, sleep: async () => {} });

    const revision = platformCalls().find((request) => request.path === "/v1/agents/projects/pp-a/revisions")!;
    expect(revision.json()).not.toHaveProperty("description");
  });

  it("says the description applies to the reused revision when the source is unchanged", async () => {
    routeHappyPath();
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 200, body: { revisionId: "rev-1", deduplicated: true } });
    await deploy({ client, link: link(), root, activate: true, description: "Greet callers in German", log, pollIntervalMs: 1, sleep: async () => {} });

    expect(lines).toContain('Revision rev-1 (unchanged source, reused). Its description is now "Greet callers in German".');
  });

  it("keeps the plain line for a reused revision without a description", async () => {
    routeHappyPath();
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 200, body: { revisionId: "rev-1", deduplicated: true } });
    await deploy({ client, link: link(), root, activate: true, log, pollIntervalMs: 1, sleep: async () => {} });

    expect(lines).toContain("Revision rev-1 (unchanged source, reused).");
  });

  it("stops on the platform's revision_invalid_argument with its message, and activates nothing", async () => {
    routeHappyPath();
    cloud.route("POST /v1/agents/projects/pp-a/revisions", {
      status: 400,
      body: { code: "revision_invalid_argument", category: "validation", retryable: false, message: "The description has a control character", correlationId: "corr-7" },
    });

    await expect(
      deploy({ client, link: link(), root, activate: true, description: "Greet callers in German", log, sleep: async () => {} }),
    ).rejects.toThrow("The description has a control character (HTTP 400, revision_invalid_argument, correlation corr-7)");
    expect(platformCalls().some((request) => request.path.endsWith("/activations"))).toBe(false);
  });

  it("names the platform code and correlation id for any other refusal", async () => {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", {
      status: 413,
      body: { code: "upload_too_large", category: "validation", retryable: false, message: "The archive is too large", correlationId: "corr-9" },
    });
    await expect(
      deploy({ client, link: link(), root, activate: true, log, sleep: async () => {} }),
    ).rejects.toThrow("The archive is too large (HTTP 413, upload_too_large, correlation corr-9)");
  });
});

describe("deployDescription", () => {
  it("takes the first line, trimmed", () => {
    expect(deployDescription("  Greet callers in German  ")).toBe("Greet callers in German");
    expect(deployDescription("Greet callers in German\n\nThe rest is ignored.")).toBe("Greet callers in German");
    expect(deployDescription("Greet callers in German\r\nThe rest")).toBe("Greet callers in German");
  });

  it("takes 160 characters and refuses 161, counting an emoji as one, and never cuts", () => {
    expect(deployDescription("a".repeat(160))).toBe("a".repeat(160));
    expect(deployDescription("😀".repeat(160))).toBe("😀".repeat(160));
    expect(() => deployDescription("a".repeat(161))).toThrow(
      "[CURB_DEPLOY_MESSAGE_INVALID] The deploy message is 161 characters, and the limit is 160.\n" +
        'Fix: Pass a short summary, such as npx curb deploy -m "Greet callers in German".',
    );
  });

  it("measures only the first line", () => {
    expect(deployDescription(`Short\n${"a".repeat(500)}`)).toBe("Short");
  });

  it("refuses a message with nothing on its first line", () => {
    for (const empty of ["   ", "\nGreet callers in German"]) {
      expect(() => deployDescription(empty)).toThrow("[CURB_DEPLOY_MESSAGE_INVALID] The deploy message has nothing on its first line.");
    }
  });
});
