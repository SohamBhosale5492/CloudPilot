import { describe, expect, it } from "vitest";
import { createMsalConfiguration, readFrontendConfig } from "./config";

const validEnv = {
  VITE_ENTRA_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  VITE_ENTRA_CLIENT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  VITE_ENTRA_API_CLIENT_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  VITE_ENTRA_API_SCOPE: "api://cccccccc-cccc-4ccc-8ccc-cccccccccccc/access_as_user",
  VITE_API_BASE_URL: "/"
} as ImportMetaEnv;

describe("frontend authentication configuration", () => {
  it("requires explicit Entra tenant, client, API, and scope configuration", () => {
    const result = readFrontendConfig({} as ImportMetaEnv, "http://localhost:5173");
    expect(result.config).toBeNull();
    expect(result.errors).toHaveLength(4);
    expect(result.errors.join(" ")).toContain("VITE_ENTRA_API_SCOPE");
  });

  it("builds a tenant-specific MSAL configuration from valid values", () => {
    const result = readFrontendConfig(validEnv, "http://localhost:5173");
    expect(result.errors).toEqual([]);
    expect(result.config?.redirectUri).toBe("http://localhost:5173");
    expect(result.config?.apiBaseUrl).toBe("/");
    expect(createMsalConfiguration(result.config!).auth.authority).toBe("https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("rejects malformed tenant and client identifiers", () => {
    const result = readFrontendConfig({ ...validEnv, VITE_ENTRA_TENANT_ID: "common", VITE_ENTRA_CLIENT_ID: "not-a-guid" } as ImportMetaEnv, "https://cloudpilot.example");
    expect(result.config).toBeNull();
    expect(result.errors).toHaveLength(2);
  });

  it("rejects an insecure remote API origin", () => {
    const result = readFrontendConfig({ ...validEnv, VITE_API_BASE_URL: "http://api.example.com" } as ImportMetaEnv, "https://cloudpilot.example");
    expect(result.config).toBeNull();
    expect(result.errors).toContain("VITE_API_BASE_URL must be a same-origin path, HTTPS URL, or loopback HTTP URL.");
  });
});
