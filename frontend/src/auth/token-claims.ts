import { readCloudPilotRoles, type CloudPilotRole } from "./permissions";

export interface DisplayTokenClaims {
  roles: CloudPilotRole[];
  tenantId?: string;
  subject?: string;
}

/** Decodes only for UI affordances; API authorization and signature checks remain server-side. */
export function readDisplayClaims(accessToken: string): DisplayTokenClaims {
  try {
    const payloadPart = accessToken.split(".")[1];
    if (!payloadPart) return { roles: [] };
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return {
      roles: readCloudPilotRoles(payload.roles),
      ...(typeof payload.tid === "string" ? { tenantId: payload.tid } : {}),
      ...(typeof payload.sub === "string" ? { subject: payload.sub } : {})
    };
  } catch {
    return { roles: [] };
  }
}
