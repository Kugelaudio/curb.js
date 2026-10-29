import { randomUUID } from "node:crypto";
import { CLI_REFUSAL_CODES, formatCliRefusal } from "../refusal.js";

/**
 * The one HTTP helper for the KugelAudio cloud commands (`curb login`, `deploy`,
 * `secrets push`). Two servers answer: the web app (`/api/cli/*`, error envelope
 * `{ error, error_code, details }`) and the agent platform (`/v1/agents/*`, a flat
 * `{ code, message, details, correlationId }`). Both are read into one CloudError whose
 * message is a single actionable line, because these commands are run by people and by
 * coding agents alike and neither should have to read a stack trace.
 */

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

export interface CloudRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  accessToken?: string;
  /** The organisation public id; the platform's `X-Kugel-Tenant`. */
  tenant?: string;
  body?: unknown;
  /** The platform requires one on every state-changing call. Minted when omitted. */
  idempotencyKey?: string;
  /** The web app URL, named in messages that send the user to the dashboard. */
  webUrl?: string;
  /** What a 401 means for this credential; `curb login`'s session expiring when absent. */
  unauthorized?: string;
}

export interface CloudResponse<T> {
  status: number;
  body: T;
}

const SAFE_METHODS = new Set(["GET"]);

export async function requestJson<T>(request: CloudRequest): Promise<CloudResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.accessToken) headers.Authorization = `Bearer ${request.accessToken}`;
  if (request.tenant) headers["X-Kugel-Tenant"] = request.tenant;
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  if (!SAFE_METHODS.has(request.method)) {
    headers["Idempotency-Key"] = request.idempotencyKey ?? randomUUID();
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
    throw new CloudError(`Could not reach ${new URL(request.url).origin}: ${reason}`, 0, undefined);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new CloudError(
        `${request.method} ${new URL(request.url).pathname} answered HTTP ${response.status} with a body that is not JSON.`,
        response.status,
        undefined,
      );
    }
  }
  if (!response.ok) throw cloudError(response.status, payload, request);
  return { status: response.status, body: payload as T };
}

interface ErrorFields {
  code?: string;
  message?: string;
  feature?: string;
  correlationId?: string;
}

/** Reads either server's error body into the fields a message needs. */
export function readErrorBody(payload: unknown): ErrorFields {
  if (payload === null || typeof payload !== "object") return {};
  const body = payload as Record<string, unknown>;
  const details = (body.details ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  return {
    // Platform: `code`. Web: the platform's code travels as details.platform_code, the
    // web's own as error_code; the platform's is the more specific one.
    code: str(body.code) ?? str(details.platform_code) ?? str(body.error_code),
    message: str(body.message) ?? str(body.error),
    feature: str(details.feature),
    correlationId: str(body.correlationId) ?? str(details.correlation_id) ?? str(body.request_id),
  };
}

/**
 * The organization does not have hosted agents switched on. The web app answers its CLI routes
 * (`/api/cli/agents`, the agent picker every first deploy starts with) with `agents_not_enabled`;
 * the platform answers every tenant route with `agents_alpha_required` once a project is linked.
 * Both are 403.
 */
const HOSTED_AGENTS_NOT_ENABLED: ReadonlySet<string> = new Set(["agents_not_enabled", "agents_alpha_required"]);

export function isHostedAgentsNotEnabled(error: CloudError): boolean {
  return error.status === 403 && error.code !== undefined && HOSTED_AGENTS_NOT_ENABLED.has(error.code);
}

/** What to do when hosted agents are not switched on: who switches them on, and what keeps
 * working until then. `answered` names the server's own status and code. */
export function hostedAgentsNotEnabledMessage(answered: string): string {
  return formatCliRefusal(
    CLI_REFUSAL_CODES.hostedAgentsNotEnabled,
    "Hosted agents are not switched on for your KugelAudio organization. They are in a closed alpha, " +
      `switched on per organization (${answered}).`,
    "Ask hello@kugelaudio.com to switch them on for your organization, then run the command again. " +
      'Until then the agent runs on this machine as before: `npx curb dev` opens the preview, `npx curb say "<what a caller says>"` runs one turn.',
  );
}

/** One actionable line for each refusal a user can fix; the server's message otherwise. */
export function cloudError(
  status: number,
  payload: unknown,
  request: Pick<CloudRequest, "method" | "url" | "webUrl" | "unauthorized">,
): CloudError {
  const fields = readErrorBody(payload);
  const dashboard = request.webUrl || "the KugelAudio dashboard";
  const code = fields.code;
  const tags = [`HTTP ${status}`, code, fields.correlationId ? `correlation ${fields.correlationId}` : undefined]
    .filter(Boolean)
    .join(", ");
  let message: string;
  if (status === 401) {
    message = request.unauthorized ?? "Your KugelAudio session expired or was revoked. Run `npx curb login` and try again.";
  } else if (status === 402 && code === "upgrade_required") {
    message =
      `Your plan does not include ${fields.feature ? `"${fields.feature}"` : "this"}. ` +
      `Upgrade in ${dashboard} (Settings > Billing), then run the command again.`;
  } else if (status === 403 && code !== undefined && HOSTED_AGENTS_NOT_ENABLED.has(code)) {
    message = hostedAgentsNotEnabledMessage(tags);
  } else if (status === 403 && code === "source_import_disabled") {
    message =
      "Uploading source is not enabled for this organisation. Push the project to GitHub and " +
      `connect the repository in ${dashboard} instead.`;
  } else {
    const what = fields.message ?? `${request.method} ${new URL(request.url).pathname} failed`;
    message = `${what} (${tags})`;
  }
  return new CloudError(message, status, code);
}
