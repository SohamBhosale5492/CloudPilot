export interface VerifiedExternalIdentity {
  /** Exact issuer string accepted by the configured JWT verifier. */
  issuer: string;
  /** Exact opaque subject mapped by the verifier from the validated sub claim. */
  subject: string;
}

export function validateExternalIdentity(identity: VerifiedExternalIdentity): void {
  if (typeof identity.issuer !== "string" || identity.issuer.trim() !== identity.issuer ||
      identity.issuer.length === 0 || Buffer.byteLength(identity.issuer, "utf8") > 512) {
    throw new Error("Verified identity issuer is invalid.");
  }
  if (typeof identity.subject !== "string" || identity.subject.length === 0 ||
      identity.subject.trim() !== identity.subject || Buffer.byteLength(identity.subject, "utf8") > 512) {
    throw new Error("Verified identity subject is invalid.");
  }
}
