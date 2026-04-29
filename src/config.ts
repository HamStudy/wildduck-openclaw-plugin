import type { AccountConfig, Permission, PluginConfig, ResolvedAccount, ResolvedConfig, SecretInput } from "./types.js";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_PERMISSIONS: Permission[] = ["read"];
const DEFAULT_ACCESS_TOKEN_ENV = "WILDDUCK_ACCESS_TOKEN";
const DEFAULT_API_URL_ENV = "WILDDUCK_API_URL";
const DEFAULT_USER_ID_ENV = "WILDDUCK_USER_ID";

type Env = Record<string, string | undefined>;

export function resolveConfig(raw: unknown, env: Env = process.env): ResolvedConfig {
  const config = (raw ?? {}) as PluginConfig;

  // Resolve global defaults
  const globalApiUrl = stripTrailingSlash(config.apiUrl ?? env[DEFAULT_API_URL_ENV]);
  const globalAccessToken = resolveSecret(config.accessToken, env) ?? env[config.accessTokenEnv ?? DEFAULT_ACCESS_TOKEN_ENV];
  const globalPermissions = new Set(config.permissions?.length ? config.permissions : DEFAULT_PERMISSIONS);
  const globalWatch = normalizeWatch(config.watch ?? {});
  const globalDefaultUserId = config.defaultUserId ?? env[DEFAULT_USER_ID_ENV];

  if (!globalApiUrl) {
    throw new Error(
      `WildDuck API URL is required. Set plugins.entries.wildduck.config.apiUrl or ${DEFAULT_API_URL_ENV}.`,
    );
  }

  if (!globalAccessToken) {
    throw new Error(
      `WildDuck access token is required. Set plugins.entries.wildduck.config.accessToken, accessTokenEnv, or ${DEFAULT_ACCESS_TOKEN_ENV}.`,
    );
  }

  // Build accounts map
  const accounts = new Map<string, ResolvedAccount>();
  for (const [accountId, accountRaw] of Object.entries(config.accounts ?? {})) {
    const account = accountRaw as AccountConfig;
    const accountApiUrl = stripTrailingSlash(account.apiUrl) ?? globalApiUrl;
    const accountAccessToken =
      resolveSecret(account.accessToken, env) ?? env[account.accessTokenEnv ?? DEFAULT_ACCESS_TOKEN_ENV] ?? globalAccessToken;
    const accountPermissions = account.permissions?.length ? new Set(account.permissions) : new Set(globalPermissions);
    const accountWatch = account.watch ? normalizeWatch(account.watch) : globalWatch;

    // Resolve account credentials
    const accountUsername = account.username;
    const accountPassword = resolveSecret(account.password, env) ?? env[account.passwordEnv ?? ""];

    accounts.set(accountId, {
      userId: account.userId,
      permissions: accountPermissions,
      apiUrl: accountApiUrl,
      accessToken: accountAccessToken,
      username: accountUsername,
      password: accountPassword,
      watch: accountWatch,
    });
  }

  return {
    apiUrl: globalApiUrl,
    accessToken: globalAccessToken,
    defaultUserId: globalDefaultUserId,
    permissions: globalPermissions,
    watch: globalWatch,
    defaultAccount: config.defaultAccount,
    accounts,
  };
}

export function resolveUserId(config: ResolvedConfig, accountId?: string, explicitUserId?: string): string {
  if (explicitUserId) return explicitUserId;

  const account = accountId ? config.accounts.get(accountId) : undefined;
  if (account) return account.userId;

  if (config.defaultUserId) return config.defaultUserId;

  throw new Error(
    "A WildDuck userId is required. Pass userId to the tool, configure defaultUserId/WILDDUCK_USER_ID, or use account selection.",
  );
}

export function resolveAccount(config: ResolvedConfig, accountId?: string): ResolvedAccount | undefined {
  if (!accountId) return undefined;
  return config.accounts.get(accountId);
}

export function resolveEffectiveAccount(config: ResolvedConfig, accountId?: string): { account?: ResolvedAccount; fallbackToGlobal: boolean } {
  const account = resolveAccount(config, accountId ?? config.defaultAccount);
  if (account) return { account, fallbackToGlobal: false };
  return { account: undefined, fallbackToGlobal: true };
}

function normalizeWatch(watch: NonNullable<PluginConfig["watch"]>): ResolvedConfig["watch"] {
  return {
    enabled: watch.enabled ?? false,
    mode: watch.mode ?? "sse",
    users: watch.users ?? [],
    debounceMs: watch.debounceMs ?? 90_000,
    pollIntervalMs: watch.pollIntervalMs ?? 60_000,
    maxBufferedEvents: watch.maxBufferedEvents ?? 200,
  };
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
