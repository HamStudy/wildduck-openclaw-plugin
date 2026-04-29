import type { Permission, ResolvedConfig } from "./types.js";

const PERMISSION_ORDER: Permission[] = ["read", "draft", "send", "mutate", "filters", "admin", "watch"];

export function getEffectivePermissions(config: ResolvedConfig, accountId?: string): Set<Permission> {
  if (accountId) {
    const account = config.accounts.get(accountId);
    if (account) return account.permissions;
    // If account was explicitly specified but not found, this is an error
    throw new Error(
      `WildDuck account '${accountId}' is not configured. Available accounts: ${Array.from(config.accounts.keys()).join(", ") || "none"}.`,
    );
  }
  // Fall back to defaultAccount if no explicit accountId
  if (config.defaultAccount) {
    const account = config.accounts.get(config.defaultAccount);
    if (account) return account.permissions;
  }
  return config.permissions;
}

export function hasPermission(config: ResolvedConfig, permission: Permission, accountId?: string): boolean {
  const perms = getEffectivePermissions(config, accountId);
  return perms.has(permission) || perms.has("admin");
}

export function requirePermission(config: ResolvedConfig, permission: Permission, accountId?: string): void {
  if (!hasPermission(config, permission, accountId)) {
    const perms = getEffectivePermissions(config, accountId);
    throw new Error(
      `WildDuck permission '${permission}' is not enabled for account '${accountId ?? config.defaultAccount ?? "global"}'. Enabled permissions: ${formatPermissions(perms)}.`,
    );
  }
}

export function formatPermissions(permissions: Set<Permission>): string {
  const enabled = PERMISSION_ORDER.filter((permission) => permissions.has(permission));
  return enabled.length ? enabled.join(", ") : "none";
}
