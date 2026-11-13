export type CloudPilotRole = "admin" | "operator" | "viewer";

// These names and grants mirror phase-06/src/rbac/guard.ts.
export type Permission =
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "scan:read"
  | "scan:create"
  | "finding:read"
  | "audit:read"
  | "remediation:create"
  | "remediation:read";

export const ROLE_PERMISSIONS: Record<CloudPilotRole, ReadonlySet<Permission>> = {
  admin: new Set([
    "project:read", "project:create", "project:update", "project:delete",
    "scan:read", "scan:create", "finding:read", "audit:read",
    "remediation:create", "remediation:read"
  ]),
  operator: new Set([
    "project:read", "scan:read", "scan:create", "finding:read",
    "remediation:create", "remediation:read"
  ]),
  viewer: new Set(["project:read", "scan:read", "finding:read", "remediation:read"])
};

export function hasPermission(roles: readonly CloudPilotRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission) ?? false);
}

export function readCloudPilotRoles(value: unknown): CloudPilotRole[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((role): role is CloudPilotRole =>
    role === "admin" || role === "operator" || role === "viewer"
  ))];
}
