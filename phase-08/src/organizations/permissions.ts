export type OrganizationRole = "owner" | "admin" | "operator" | "viewer";

export type OrganizationPermission =
  | "organization:read"
  | "organization:update"
  | "organization:members:manage"
  | "organization:integrations"
  | "organization:integrations:manage"
  | "organization:transfer"
  | "organization:delete"
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "scan:read"
  | "scan:create"
  | "finding:read"
  | "audit:read"
  | "remediation:create"
  | "remediation:approve"
  | "remediation:read";

const ADMIN = new Set<OrganizationPermission>([
  "organization:read", "organization:update", "organization:members:manage", "organization:integrations", "organization:integrations:manage",
  "project:read", "project:create", "project:update", "project:delete",
  "scan:read", "scan:create", "finding:read", "audit:read", "remediation:create", "remediation:approve", "remediation:read"
]);

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: new Set([...ADMIN, "organization:transfer", "organization:delete"]),
  admin: ADMIN,
  operator: new Set([
    "organization:read", "organization:integrations", "project:read", "scan:read", "scan:create", "finding:read",
    "remediation:create", "remediation:read"
  ]),
  viewer: new Set([
    "organization:read", "organization:integrations", "project:read", "scan:read", "finding:read", "remediation:read"
  ])
};

export function hasOrganizationPermission(
  role: OrganizationRole | string | null | undefined,
  permission: OrganizationPermission
): boolean {
  if (role !== "owner" && role !== "admin" && role !== "operator" && role !== "viewer") return false;
  return ROLE_PERMISSIONS[role].has(permission);
}
