import type { Permission, ResolvedConfig } from "./types.js";

const PERMISSION_ORDER: Permission[] = ["read", "draft", "send", "mutate", "filters", "admin", "watch"];

export function hasPermission(config: ResolvedConfig, permission: Permission): boolean {
  return config.permissions.has(permission) || config.permissions.has("admin");
}

export function requirePermission(config: ResolvedConfig, permission: Permission): void {
  if (!hasPermission(config, permission)) {
    throw new Error(
      `WildDuck permission '${permission}' is not enabled. Enabled permissions: ${formatPermissions(config.permissions)}.`,
    );
  }
}

export function formatPermissions(permissions: Set<Permission>): string {
  const enabled = PERMISSION_ORDER.filter((permission) => permissions.has(permission));
  return enabled.length ? enabled.join(", ") : "none";
}
