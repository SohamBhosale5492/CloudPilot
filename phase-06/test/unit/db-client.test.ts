import test from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma, getPrismaClient, requireDatabaseUrl } from "../../src/db/client.js";
import { cleanupTestOwnedFixtures, requireDedicatedPhase06TestDatabase } from "../integration/safety.js";

test("DATABASE_URL validation fails immediately when missing or malformed", async () => {
  const previous = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    assert.throws(() => getPrismaClient(), /DATABASE_URL is required/);
    process.env.DATABASE_URL = "not a url";
    assert.throws(() => getPrismaClient(), /valid PostgreSQL/);
    process.env.DATABASE_URL = "https://db.example/name";
    assert.throws(() => getPrismaClient(), /valid PostgreSQL/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("valid DATABASE_URL initializes and reuses Prisma client", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:password@localhost:55433/cloudpilot_integration_test";
  try {
    assert.equal(requireDatabaseUrl(), process.env.DATABASE_URL);
    const first = getPrismaClient();
    assert.equal(getPrismaClient(), first);
    await disconnectPrisma();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("integration database gate requires the exact loopback host, port, database, and runtime role", () => {
  assert.throws(() => requireDedicatedPhase06TestDatabase(undefined), /is required/);
  assert.throws(() => requireDedicatedPhase06TestDatabase("not a URL"), /valid PostgreSQL/);
  const valid = "postgresql://cloudpilot_integration_test:test@127.0.0.1:56440/cloudpilot_runtime_role_test";
  for (const invalid of [
    "https://cloudpilot_integration_test:test@127.0.0.1:56440/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@localhost/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@127.0.0.1:5432/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@127.0.0.1:55433/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@127.0.0.1:56439/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@db.example:56440/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@127.0.0.1:56440/cloudpilot_integration_test",
    "postgresql://cloudpilot_migrator:test@127.0.0.1:56440/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@localhost:56440/cloudpilot_runtime_role_test",
    "postgresql://cloudpilot_integration_test:test@[::1]:56440/cloudpilot_runtime_role_test",
    `${valid}?host=db.example`
  ]) {
    assert.throws(() => requireDedicatedPhase06TestDatabase(invalid), /must target|valid PostgreSQL/);
  }

  assert.equal(requireDedicatedPhase06TestDatabase(valid), valid);
});

test("fixture cleanup deletes only explicitly supplied tenant IDs", async () => {
  const calls: unknown[] = [];
  const prisma = { tenant: { deleteMany: async (args: unknown) => { calls.push(args); return { count: 1 }; } } } as never;
  const ids = ["test-run-tenant-a", "test-run-tenant-b"];
  await cleanupTestOwnedFixtures(prisma, ids);
  assert.deepEqual(calls, [{ where: { id: { in: ids } } }]);
  calls.length = 0;
  await cleanupTestOwnedFixtures(prisma, []);
  assert.deepEqual(calls, []);
});
