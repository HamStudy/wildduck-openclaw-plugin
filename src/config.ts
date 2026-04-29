import type { Permission, PluginConfig, ResolvedConfig, SecretInput } from "./types.js";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_PERMISSIONS: Permission[] = ["read"];
const DEFAULT_ACCESS_TOKEN_ENV = "WILDDUCK_ACCESS_TOKEN";
const DEFAULT_API_URL_ENV = "WILDDUCK_API_URL";
const DEFAULT_USER_ID_ENV = "WILDDUCK_USER_ID";

type Env = Record<string, string | undefined>;

export function resolveConfig(raw: unknown, env: Env = process.env): ResolvedConfig {
  const config = (raw ?? {}) as PluginConfig;
  const apiUrl = stripTrailingSlash(config.apiUrl ?? env[DEFAULT_API_URL_ENV]);

  if (!apiUrl) {
    throw new Error(`WildDuck API URL is required. Set plugins.entries.wildduck.config.apiUrl or ${DEFAULT_API_URL_ENV}.`);
  }

  const accessToken = resolveSecret(config.accessToken, env) ?? env[config.accessTokenEnv ?? DEFAULT_ACCESS_TOKEN_ENV];
  if (!accessToken) {
    throw new Error(
      `WildDuck access token is required. Set plugins.entries.wildduck.config.accessToken, accessTokenEnv, or ${DEFAULT_ACCESS_TOKEN_ENV}.`,
    );
  }

  const permissions = new Set(config.permissions?.length ? config.permissions : DEFAULT_PERMISSIONS);
  const watch = config.watch ?? {};

  return {
    apiUrl,
    accessToken,
    defaultUserId: config.defaultUserId ?? env[DEFAULT_USER_ID_ENV],
    permissions,
    watch: {
      enabled: watch.enabled ?? false,
      mode: watch.mode ?? "sse",
      users: watch.users ?? [],
      debounceMs: watch.debounceMs ?? 90_000,
      pollIntervalMs: watch.pollIntervalMs ?? 60_000,
      maxBufferedEvents: watch.maxBufferedEvents ?? 200,
    },
  };
}

export function resolveUserId(config: ResolvedConfig, explicit?: string): string {
  const userId = explicit ?? config.defaultUserId;
  if (!userId) {
    throw new Error("A WildDuck userId is required. Pass userId to the tool or configure defaultUserId/WILDDUCK_USER_ID.");
  }
  return userId;
}

function resolveSecret(secret: SecretInput | undefined, env: Env): string | undefined {
  if (!secret) {
    return undefined;
  }
  if (typeof secret === "string") {
    return secret;
  }
  if (secret.source === "env") {
    return env[secret.id];
  }
  throw new Error(`Unsupported WildDuck SecretRef source for runtime resolution: ${secret.source}`);
}

function stripTrailingSlash(value: string | undefined): string {
  return (value ?? "").replace(/\/+$/, "");
}
