import assert from "node:assert/strict";
import test from "node:test";
import { internalMutationBoundary, mutationRequestHash } from "../../src/github/internal-mutation-boundary.js";

const scope = Object.freeze({ repositoryId: "9007199254740993", installationRecordId: "installation-record",
  artifactHash: "a".repeat(64), baseRef: "main", baseCommitSha: "b".repeat(40) });

test("each GitHub mutation stage is a one-shot mutation followed by a separate read-only verifier", async () => {
  const stages = ["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"] as const;
  for (const stage of stages) {
    const order: string[] = [];
    let passedFingerprint: string | undefined;
    const boundary = internalMutationBoundary<{ readonly remoteId: string }, string>({
      stage,
      scope,
      requestFingerprint: "d".repeat(64),
      operation: { operationId: `${stage}:fixture`, expectedCommitSha: "c".repeat(40) },
      expected: { immutableRepositoryId: scope.repositoryId, commitSha: "c".repeat(40) },
      async mutate(identity) { order.push("mutation"); passedFingerprint = identity.requestFingerprint; return { remoteId: `${stage}-id` }; },
      async verify(response) { order.push("read_only_verification"); return response.remoteId; }
    });

    assert.equal(boundary.stage, stage);
    assert.deepEqual(boundary.scope, scope);
    assert.ok(Object.isFrozen(boundary.scope));
    assert.ok(Object.isFrozen(boundary.operation));
    assert.equal(boundary.expected.requestFingerprint, "d".repeat(64));
    assert.equal(boundary.requestHash, mutationRequestHash(stage, scope, boundary.operation, boundary.expected));
    await assert.rejects(boundary.verify({ remoteId: `${stage}-id` }), /mutation_response_unavailable/);
    const response = await boundary.mutateOnce();
    assert.equal(passedFingerprint, boundary.expected.requestFingerprint);
    assert.deepEqual(order, ["mutation"]);
    assert.equal(await boundary.verify(response), `${stage}-id`);
    assert.deepEqual(order, ["mutation", "read_only_verification"]);
    await assert.rejects(boundary.mutateOnce(), /mutation_attempt_already_consumed/);
  }
});

test("a rejected or ambiguous mutation consumes its operation boundary and cannot be blindly retried", async () => {
  let calls = 0;
  const boundary = internalMutationBoundary({
    stage: "commit", scope, requestFingerprint: "d".repeat(64), operation: { parentSha: "b".repeat(40), treeSha: "c".repeat(40) },
    expected: { commitSha: "d".repeat(40), parentSha: "b".repeat(40) },
    async mutate() { calls++; throw new Error("ambiguous transport result"); },
    async verify() { assert.fail("verification must not run without a mutation response"); }
  });
  await assert.rejects(boundary.mutateOnce(), /ambiguous transport result/);
  await assert.rejects(boundary.mutateOnce(), /mutation_attempt_already_consumed/);
  assert.equal(calls, 1);
});
