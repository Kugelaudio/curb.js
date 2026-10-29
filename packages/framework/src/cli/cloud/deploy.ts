import { packProject, formatBytes, type ArchiveLimits, ARCHIVE_LIMITS } from "./archive.js";
import { type CloudClient, seg } from "./client.js";
import { CloudError } from "./http.js";
import type { Link } from "./link.js";

/**
 * `curb deploy`: pack, upload, capture, activate, watch.
 *
 *   POST /v1/agents/projects/{p}/uploads        -> presigned PUT
 *   PUT  <presigned url>                          the tar.gz
 *   POST /v1/agents/projects/{p}/revisions       {adapter:"archive", ...} -> revisionId
 *   POST /v1/agents/environments/{e}/activations {revisionId, activate}   -> outcome
 *   GET  /v1/agents/builds/{b}, /v1/agents/environments/{e}/deployments   until settled
 */

/**
 * Where a deploy goes: the agent's platform project and the environment to activate in. A
 * `curb login` link carries the dashboard page too; a host-issued platform token does not,
 * and its messages then name the dashboard without a URL.
 */
export type DeployTarget = Pick<Link, "orgId" | "platformProjectId" | "environmentId"> & { dashboardUrl?: string };

export interface DeployOptions {
  client: CloudClient;
  link: DeployTarget;
  root: string;
  /** `--no-activate`: build and prove readiness, leave the serving deployment as it is. */
  activate: boolean;
  log: (line: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  limits?: ArchiveLimits;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployResult {
  revisionId: string;
  deploymentId?: string;
  state: "active" | "ready";
  /** Absent when the target carries no dashboard page. */
  playgroundUrl?: string;
}

interface UploadTicket {
  uploadObjectKey: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  expiresAt?: string;
}

interface CaptureResponse {
  revisionId: string;
  deduplicated?: boolean;
  fileCount?: number;
}

interface ActivationOutcome {
  state: string;
  buildId?: string;
  deploymentId?: string;
}

interface Build {
  buildId: string;
  state: string;
  failureCode?: string;
  attempts?: number;
}

interface Deployment {
  deploymentId: string;
  revisionId: string;
  state: string;
  failure?: { code?: string; message?: string };
}

const BUILD_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function playgroundUrl(link: DeployTarget): string | undefined {
  return link.dashboardUrl ? `${link.dashboardUrl}/playground` : undefined;
}

/** Where to look at the agent: its playground URL, or the dashboard when there is none. */
function whereToCheck(link: DeployTarget): string {
  return playgroundUrl(link) ?? "the agent in the KugelAudio dashboard";
}

export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { client, link, log } = options;
  const tenant = link.orgId;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60 * 1000);

  const archive = packProject(options.root, options.limits ?? ARCHIVE_LIMITS);
  log(
    `Packed ${archive.files} files (${formatBytes(archive.unpackedBytes)} unpacked, ` +
      `${formatBytes(archive.bytes.length)} compressed).`,
  );

  const projectPath = `/v1/agents/projects/${seg(link.platformProjectId)}`;
  const { body: ticket } = await client.platform<UploadTicket>("POST", `${projectPath}/uploads`, tenant, {
    archiveFormat: "tar.gz",
    sizeBytes: archive.bytes.length,
    digest: archive.digest,
  });
  await putArchive(ticket, archive.bytes);
  log("Uploaded.");

  const { body: revision } = await client.platform<CaptureResponse>("POST", `${projectPath}/revisions`, tenant, {
    adapter: "archive",
    uploadObjectKey: ticket.uploadObjectKey,
    archiveFormat: "tar.gz",
    uploadDigest: archive.digest,
  });
  log(`Revision ${revision.revisionId}${revision.deduplicated ? " (unchanged source, reused)" : ""}.`);

  const deploymentsPath = `/v1/agents/environments/${seg(link.environmentId)}/deployments`;
  const before = new Set(
    (await client.platform<{ deployments: Deployment[] }>("GET", deploymentsPath, tenant)).body.deployments.map(
      (deployment) => deployment.deploymentId,
    ),
  );

  const { body: outcome } = await client.platform<ActivationOutcome>(
    "POST",
    `/v1/agents/environments/${seg(link.environmentId)}/activations`,
    tenant,
    { revisionId: revision.revisionId, activate: options.activate },
  );
  const wanted = options.activate ? "active" : "ready";
  const done = (deploymentId?: string): DeployResult => {
    const url = playgroundUrl(link);
    log(
      options.activate
        ? url
          ? `Live. Try it in the playground: ${url}`
          : "Live. Try it from the agent's page in the KugelAudio dashboard."
        : `Built and ready, not activated. Activate it from ${whereToCheck(link)}`,
    );
    return { revisionId: revision.revisionId, deploymentId, state: wanted, ...(url ? { playgroundUrl: url } : {}) };
  };
  if (outcome.state === "activated" || (outcome.state === "ready" && !options.activate)) return done(outcome.deploymentId);
  if (outcome.state !== "pending" && outcome.state !== "ready") {
    throw new Error(`The platform answered the activation with state "${outcome.state}", which this CLI does not know.`);
  }

  const progress = progressLine(log);
  const checkDeadline = (what: string) => {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the ${what}. It may still finish: check ${whereToCheck(link)}.`);
    }
  };

  if (outcome.buildId) {
    for (;;) {
      const { body: build } = await client.platform<Build>("GET", `/v1/agents/builds/${seg(outcome.buildId)}`, tenant);
      progress(`build ${build.state}${build.attempts && build.attempts > 1 ? ` (attempt ${build.attempts})` : ""}`);
      if (build.state === "succeeded") break;
      if (BUILD_TERMINAL.has(build.state)) {
        throw new Error(
          `Build ${build.buildId} ${build.state}${build.failureCode ? ` (${build.failureCode})` : ""}. ` +
            `Read its log in the dashboard${link.dashboardUrl ? `: ${link.dashboardUrl}` : "."}`,
        );
      }
      checkDeadline("build");
      await sleep(pollIntervalMs);
    }
  }

  for (;;) {
    const { body } = await client.platform<{ deployments: Deployment[] }>("GET", deploymentsPath, tenant);
    const deployment = body.deployments.find(
      (candidate) =>
        candidate.revisionId === revision.revisionId &&
        (candidate.deploymentId === outcome.deploymentId || !before.has(candidate.deploymentId)),
    );
    if (deployment) {
      progress(`deployment ${deployment.state}`);
      if (deployment.state === wanted) return done(deployment.deploymentId);
      if (deployment.state === "failed") {
        const failure = deployment.failure;
        throw new Error(
          `Deployment ${deployment.deploymentId} failed${failure?.code ? ` (${failure.code})` : ""}: ` +
            `${failure?.message ?? "no reason given"}`,
        );
      }
    } else {
      progress("deployment waiting");
    }
    checkDeadline("deployment");
    await sleep(pollIntervalMs);
  }
}

/** Prints a progress line only when it changed, so polling stays compact in a terminal and in a log. */
function progressLine(log: (line: string) => void): (line: string) => void {
  let last = "";
  return (line) => {
    if (line === last) return;
    last = line;
    log(`  ${line}`);
  };
}

async function putArchive(ticket: UploadTicket, bytes: Buffer): Promise<void> {
  if (!ticket.url || !ticket.uploadObjectKey) {
    throw new Error("The platform answered the upload request without a url or uploadObjectKey.");
  }
  let response: Response;
  try {
    response = await fetch(ticket.url, {
      method: ticket.method || "PUT",
      // fetch sets Content-Length from the byte body, which a presigned PUT requires.
      headers: ticket.headers ?? {},
      body: new Uint8Array(bytes),
    });
  } catch (cause) {
    throw new CloudError(
      `Could not upload the archive to ${new URL(ticket.url).origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
      0,
      undefined,
    );
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new CloudError(
      `The object store refused the upload with HTTP ${response.status}${text ? `: ${text}` : ""}. ` +
        (response.status === 403 ? "The upload URL may have expired; run `npx curb deploy` again." : ""),
      response.status,
      undefined,
    );
  }
}
