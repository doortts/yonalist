import { deriveHostUrl } from "./githubServers";

export interface OAuthLoginOptions {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function randomState(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * GitHub OAuth authorization-code login through a loopback redirect. The
 * authorization page opens in an app-owned webview so GitHub Enterprise web
 * session cookies are available to avatar image requests inside the app.
 */
export async function loginWithOAuth(options: OAuthLoginOptions): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      "OAuth login requires the desktop app. Save a personal access token for this server instead."
    );
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const hostUrl = deriveHostUrl(options.apiBaseUrl);

  const port = await invoke<number>("oauth_start");
  const redirectUri = `http://localhost:${port}/auth`;
  const state = randomState();

  const authorizeUrl =
    `${hostUrl}/login/oauth/authorize?` +
    new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: options.scopes.join(" "),
      state
    }).toString();

  await invoke("open_url", { url: authorizeUrl });

  const params = await invoke<Record<string, string>>("oauth_wait");
  if (params.error) {
    throw new Error(params.error_description || params.error);
  }
  if (params.state !== state) {
    throw new Error("OAuth state mismatch; aborting login.");
  }
  if (!params.code) {
    throw new Error("OAuth callback did not include an authorization code.");
  }

  const raw = await invoke<string>("oauth_exchange", {
    tokenUrl: `${hostUrl}/login/oauth/access_token`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    code: params.code,
    redirectUri
  });

  const response = JSON.parse(raw) as AccessTokenResponse;
  if (response.error) {
    throw new Error(response.error_description || response.error);
  }
  if (!response.access_token) {
    throw new Error("GitHub did not return an access token.");
  }
  return response.access_token;
}
