import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

/** Everything one server's OAuth session needs across restarts. */
type PersistedAuth = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

/**
 * Node-only `OAuthClientProvider` that persists tokens + dynamic client
 * registration per server under `.mcp-auth/<serverId>.json` (gitignored).
 *
 * `redirectToAuthorization` does NOT open a browser — this provider runs
 * inside the WS server, so it hands the URL to `onAuthorizationUrl`, which
 * forwards it to the preview UI where the user opens it. The OAuth redirect
 * lands on the server's `/oauth/callback`, which calls back into the manager.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private data: PersistedAuth;
  /** The `state` issued for the in-flight flow. In memory on purpose: a flow
   * cannot survive a restart anyway (the parked transport is gone). */
  private issuedState: string | null = null;

  constructor(
    private readonly serverId: string,
    private readonly dir: string,
    private readonly callbackUrl: string,
    private readonly onAuthorizationUrl: (url: URL) => void,
  ) {
    this.data = this.load();
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "KugelAudio Agent Framework",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** Embed the server id so the callback can route the code back. The nonce
   * is remembered and checked in {@link consumeState} (CSRF protection). */
  state(): string {
    this.issuedState = `${encodeURIComponent(this.serverId)}.${crypto.randomUUID()}`;
    return this.issuedState;
  }

  /** Validate a callback `state` against the one issued for this flow. Each
   * state is single-use: a successful match clears it. */
  consumeState(state: string): boolean {
    const matches = this.issuedState !== null && state === this.issuedState;
    if (matches) this.issuedState = null;
    return matches;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.data.clientInformation = clientInformation;
    this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    this.save();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.data.codeVerifier = codeVerifier;
    this.save();
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) {
      throw new Error(`No PKCE code verifier stored for MCP server "${this.serverId}".`);
    }
    return this.data.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.data = {};
      rmSync(this.file, { force: true });
      return;
    }
    if (scope === "client") delete this.data.clientInformation;
    if (scope === "tokens") delete this.data.tokens;
    if (scope === "verifier") delete this.data.codeVerifier;
    this.save();
  }

  private get file(): string {
    // Server ids are validated (alphanumeric + dash/underscore) before a
    // provider is created, so the filename cannot escape the auth directory.
    return join(this.dir, `${this.serverId}.json`);
  }

  private load(): PersistedAuth {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as PersistedAuth;
    } catch {
      // KEEP-JUSTIFIED: a missing/corrupt auth file simply means "not
      // authenticated yet" — the OAuth flow will run and rewrite it.
      return {};
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
