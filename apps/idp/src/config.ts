/**
 * Environment, read in one place so the server and the scripts agree on it.
 * Every variable is documented in the repo's `.env.example`.
 */

import { readPersonaEmailOverrides } from "../../../packages/policy-schema/contract/persona-email-contract.ts";

/** Arcade Cloud's OAuth callback. Confirm against the "Redirect URL" the Arcade dashboard shows (#13). */
export const DEFAULT_ARCADE_REDIRECT_URI = "https://cloud.arcade.dev/api/v1/oauth/callback";

/**
 * A fixed secret for local runs only. Refused under NODE_ENV=production —
 * Render generates a real one (`generateValue: true` in render.yaml).
 */
const DEV_SECRET = "cg-idp-dev-secret-not-for-production-0000000000";

/**
 * One OAuth client this service keeps, as the environment asks for it.
 *
 * Better Auth generates the `client_id` and `client_secret` and they cannot be
 * pinned from env, so nothing here is a credential: a spec is a **key** (the
 * fixed primary key of the row, so the same client is found again on the next
 * boot), a display name for the login and consent pages, and the redirect URIs
 * allowlisted on it.
 */
export interface OAuthClientSpec {
  key: string;
  name: string;
  redirectUris: string[];
}

export interface IdpConfig {
  port: number;
  dbPath: string;
  /** Public origin and OAuth issuer. */
  baseURL: string;
  /** True when nothing set the public URL and `baseURL` is the localhost fallback. */
  baseURLIsFallback: boolean;
  secret: string;
  /** The first client's redirect URIs. Same value as `clients[0].redirectUris`. */
  redirectUris: string[];
  /**
   * Every client, in the order `IDP_OAUTH_CLIENTS` names them. Always at least
   * one — `clients[0]` is the Arcade registration everything before #79
   * assumed, and with nothing configured it is the only one.
   */
  clients: OAuthClientSpec[];
  /**
   * The bearer `POST /admin/reset` requires (#23). Blank is a state, not a
   * default: the route does not exist at all, `/health` reports
   * `reset: "disabled"`, and there is no development fallback because a
   * published one would be the same as no bearer. The same variable name and
   * the same rules as `apps/hooks` and `apps/loan-app`, so one value
   * configures all three.
   */
  resetToken: string;
}

/** The one client every deployment has, and the only one before #79. */
export const PRIMARY_CLIENT_KEY = "arcade";

/**
 * A client key is a row primary key and half of an environment variable name,
 * so it is kept to the shape both can hold without quoting or escaping.
 */
const CLIENT_KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `arcade-user-source` -> `IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE`. The
 * per-client override; without it a client falls back to the shared
 * `IDP_OAUTH_REDIRECT_URIS`, which is what keeps a one-client deployment
 * configured exactly as it was.
 */
export function redirectUrisVar(key: string): string {
  return `IDP_OAUTH_REDIRECT_URIS_${key.toUpperCase().replace(/-/g, "_")}`;
}

/** `arcade-user-source` -> `Arcade User Source`, for the consent page. */
function displayName(key: string): string {
  return key
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads `IDP_OAUTH_CLIENTS`, which names the clients by key.
 *
 * Unset — the shape every deployment has today — means exactly
 * `[PRIMARY_CLIENT_KEY]`, so nothing changes for anyone who does not opt in.
 * The primary key is always first and always present: it is the row #13
 * registered in the Arcade dashboard, and dropping it from the list would
 * quietly stop reconciling the live client rather than fail.
 */
function readClients(env: Record<string, string | undefined>, sharedUris: string[]): OAuthClientSpec[] {
  const keys = splitList(env.IDP_OAUTH_CLIENTS);
  for (const key of keys) {
    if (!CLIENT_KEY.test(key)) {
      throw new Error(
        `IDP_OAUTH_CLIENTS: "${key}" is not a usable client key — lowercase letters, digits and hyphens only`,
      );
    }
  }

  const ordered = [PRIMARY_CLIENT_KEY, ...keys.filter((key) => key !== PRIMARY_CLIENT_KEY)];
  return [...new Set(ordered)].map((key) => {
    const override = splitList(env[redirectUrisVar(key)]);
    return {
      key,
      name: key === PRIMARY_CLIENT_KEY ? "Arcade" : displayName(key),
      redirectUris: override.length > 0 ? override : sharedUris,
    };
  });
}

export function readConfig(env: Record<string, string | undefined> = process.env): IdpConfig {
  // Validate before opening the database. An obsolete name-based variable
  // must not leave this service apparently healthy while seeding fixture
  // addresses.
  readPersonaEmailOverrides(env);
  const port = Number(env.PORT ?? 8083);

  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  // Render injects RENDER_EXTERNAL_URL into every service, so on Render
  // nothing has to be configured; locally the fallback is the port.
  const configuredURL = env.IDP_PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  const baseURL = (configuredURL || `http://localhost:${port}`).replace(/\/+$/, "");

  const redirectUris = splitList(env.IDP_OAUTH_REDIRECT_URIS ?? DEFAULT_ARCADE_REDIRECT_URI);
  const clients = readClients(env, redirectUris);

  return {
    port,
    dbPath: env.IDP_DB_PATH ?? "./idp.db",
    baseURL,
    baseURLIsFallback: !configuredURL,
    secret: secret || DEV_SECRET,
    redirectUris: clients[0]!.redirectUris,
    clients,
    resetToken: env.RESET_TOKEN?.trim() ?? "",
  };
}

export function usingDevSecret(config: IdpConfig): boolean {
  return config.secret === DEV_SECRET;
}

/** Whether `POST /admin/reset` exists on this deployment. */
export function resetEnabled(config: IdpConfig): boolean {
  return config.resetToken.length > 0;
}
