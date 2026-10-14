import { UserRole, AuthenticatedIdentity } from "../auth/jwt-verifier.js";

export type Permission =
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "scan:read"
  | "scan:create"
  | "finding:read"
  | "audit:read";

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    "project:read",
    "project:create",
    "project:update",
    "project:delete",
    "scan:read",
    "scan:create",
    "finding:read",
    "audit:read"
  ]),
  operator: new Set<Permission>([
    "project:read",
    "scan:read",
    "scan:create",
    "finding:read"
  ]),
  viewer: new Set<Permission>([
    "project:read",
    "scan:read",
    "finding:read"
  ])
};

/**
 * Checks whether the given authenticated identity has the required permission.
 * Employs deny-by-default: if identity is missing, has no matching roles,
 * or permission is not granted, returns false.
 */
export function hasPermission(identity: AuthenticatedIdentity | undefined | null, permission: Permission): boolean {
  if (!identity || !Array.isArray(identity.roles) || identity.roles.length === 0) {
    return false;
  }

  for (const role of identity.roles) {
    const permissions = ROLE_PERMISSIONS[role];
    if (permissions && permissions.has(permission)) {
      return true;
    }
  }

  return false;
}

export function assertPermission(identity: AuthenticatedIdentity | undefined | null, permission: Permission): void {
  if (!hasPermission(identity, permission)) {
    const error = new Error(`Forbidden: required permission '${permission}' not granted.`);
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }
}
