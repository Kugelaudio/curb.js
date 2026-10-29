import { type CloudResponse, requestJson } from "./http.js";

/**
 * What a client calls with: `curb login`'s session (`Credentials`), or a platform token a
 * host issued (`platform-token.ts`), which has no web app and explains its own 401.
 */
export interface CloudAccess {
  webUrl: string;
  platformApiUrl: string;
  accessToken: string;
  /** What a 401 means for this credential (`CloudRequest.unauthorized`). */
  unauthorized?: string;
}

/**
 * The caller's two servers: the web app (`/api/cli/*`, which owns orgs, projects and
 * agents) and the agent platform (`/v1/agents/*`, which owns environments, uploads,
 * revisions, builds, deployments and variables). Both take the same access token.
 */
export class CloudClient {
  constructor(readonly credentials: CloudAccess) {}

  web<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<CloudResponse<T>> {
    return requestJson<T>({
      method,
      url: `${this.credentials.webUrl}${path}`,
      accessToken: this.credentials.accessToken,
      body,
      webUrl: this.credentials.webUrl,
      unauthorized: this.credentials.unauthorized,
    });
  }

  /** `tenant` is the organisation public id; the platform needs it once a user has several. */
  platform<T>(
    method: "GET" | "POST",
    path: string,
    tenant: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<CloudResponse<T>> {
    return requestJson<T>({
      method,
      url: `${this.credentials.platformApiUrl}${path}`,
      accessToken: this.credentials.accessToken,
      tenant,
      body,
      idempotencyKey,
      webUrl: this.credentials.webUrl,
      unauthorized: this.credentials.unauthorized,
    });
  }
}

/** Path-segment encoding; ids are opaque. */
export const seg = encodeURIComponent;
