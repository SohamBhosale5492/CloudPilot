import { describe, expect, it } from "vitest";
import { hasPermission, readCloudPilotRoles, ROLE_PERMISSIONS } from "./permissions";

describe("CloudPilot UI permission map", () => {
  it("mirrors the backend grants for admin, operator, and viewer", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual(["project:read", "project:create", "project:update", "project:delete", "scan:read", "scan:create", "finding:read", "audit:read", "remediation:create", "remediation:read"]);
    expect([...ROLE_PERMISSIONS.operator]).toEqual(["project:read", "scan:read", "scan:create", "finding:read", "remediation:create", "remediation:read"]);
    expect([...ROLE_PERMISSIONS.viewer]).toEqual(["project:read", "scan:read", "finding:read", "remediation:read"]);
  });

  it("denies unknown roles and filters claims to the three supported role values", () => {
    expect(readCloudPilotRoles(["admin", "root", "viewer", "viewer"])).toEqual(["admin", "viewer"]);
    expect(hasPermission([], "project:read")).toBe(false);
    expect(hasPermission(["viewer"], "project:create")).toBe(false);
    expect(hasPermission(["operator"], "remediation:create")).toBe(true);
  });
});
