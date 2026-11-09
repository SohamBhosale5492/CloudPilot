import { createHash } from "node:crypto";

/** A durable intent committed, but lease revalidation failed before the request. */
export class MutationIntentCommittedError extends Error {
  constructor() { super("mutation_intent_committed_lease_lost"); }
}

/** Internal primitive: mutation and read-only verification are distinct operations. */
export interface MutationBoundaryScope {
  readonly proposalId?: string;
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly repositoryBindingId?: string;
  readonly repositoryId: string;
  readonly installationRecordId: string;
  readonly artifactHash: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
}

export interface VerifiedGitHubMutationProof extends MutationBoundaryScope {
  readonly stage: InternalMutationBoundary<unknown, unknown>["stage"];
  readonly operationKey: string;
  readonly requestHash: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly commitSha?: string;
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

export interface InternalMutationBoundary<TResponse, TVerified> {
  readonly stage: "blob" | "tree" | "commit" | "branch" | "pull_request" | "pull_request_close";
  readonly scope: Readonly<MutationBoundaryScope>;
  /** Secret-free immutable description of the exact request. */
  readonly operation: Readonly<Record<string, string | number | boolean | null>>;
  /** Exact properties that a read-only lookup must establish before success. */
  readonly expected: Readonly<Record<string, string | number | boolean | null>>;
  readonly operationKey: string;
  readonly requestHash: string;
  readonly requestFingerprint: string;
  /** The sole mutation attempt. It rejects every second invocation, even after an ambiguous failure. */
  mutateOnce(): Promise<TResponse>;
  /** Read-only verification, available only after one mutation attempt returned. */
  verify(response: TResponse): Promise<TVerified>;
}

/** Recomputes the stable identity persisted with an intent. */
export function mutationRequestHash(
  stage: InternalMutationBoundary<unknown, unknown>["stage"],
  scope: MutationBoundaryScope,
  operation: Readonly<Record<string, string | number | boolean | null>>,
  expected: Readonly<Record<string, string | number | boolean | null>>
): string {
  return createHash("sha256").update(JSON.stringify([stage, scope,
    canonicalRecord(operation), canonicalRecord(expected)]), "utf8").digest("hex");
}

export function internalMutationBoundary<TResponse, TVerified>(input: {
  readonly stage: InternalMutationBoundary<TResponse, TVerified>["stage"];
  readonly scope: MutationBoundaryScope;
  readonly operation: Readonly<Record<string, string | number | boolean | null>>;
  readonly expected: Readonly<Record<string, string | number | boolean | null>>;
  readonly mutate: (identity: { readonly operationKey: string; readonly requestHash: string;
    readonly stage: InternalMutationBoundary<TResponse, TVerified>["stage"]; readonly requestFingerprint: string }) => Promise<TResponse>;
  readonly requestFingerprint: string;
  readonly verify: (response: TResponse) => Promise<TVerified>;
}): InternalMutationBoundary<TResponse, TVerified> {
  let attempted = false;
  let returned = false;
  const scope = Object.freeze({ ...input.scope });
  const operation = Object.freeze({ ...input.operation });
  if (!/^[a-f0-9]{64}$/.test(input.requestFingerprint)) throw new TypeError("invalid_mutation_request_fingerprint");
  // The HTTP fingerprint is included in the persisted expected descriptor, so
  // mutationRequestHash commits the intent to the exact method/target/body.
  const expected = Object.freeze({ ...input.expected, requestFingerprint: input.requestFingerprint });
  const requestHash = mutationRequestHash(input.stage, scope, operation, expected);
  const operationKey = `${input.stage}:${requestHash}`;
  return Object.freeze({
    stage: input.stage,
    scope,
    operation,
    expected,
    operationKey,
    requestHash,
    requestFingerprint: input.requestFingerprint,
    async mutateOnce() {
      if (attempted) throw new Error("mutation_attempt_already_consumed");
      attempted = true;
      const response = await input.mutate(Object.freeze({ operationKey, requestHash, stage: input.stage,
        requestFingerprint: input.requestFingerprint }));
      returned = true;
      return response;
    },
    async verify(response: TResponse) {
      if (!attempted || !returned) throw new Error("mutation_response_unavailable");
      return input.verify(response);
    }
  });
}

function canonicalRecord(value: Readonly<Record<string, string | number | boolean | null>>): readonly unknown[] {
  return Object.keys(value).sort().map((key) => [key, value[key]]);
}
