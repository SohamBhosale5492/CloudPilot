import assert from "node:assert/strict";
import test from "node:test";
import { parsePhase08AcceptanceDatabase } from "../integration/acceptance-database.js";

const accepted = "postgresql://cloudpilot_acceptance_app:test-password@127.0.0.1:56441/cloudpilot_acceptance_56441";

test("Phase 08 acceptance database parser accepts only the explicit isolated target", () => {
  assert.deepEqual(parsePhase08AcceptanceDatabase(accepted), {
    url: accepted,
    database: "cloudpilot_acceptance_56441",
    username: "cloudpilot_acceptance_app",
    host: "127.0.0.1",
    port: "56441"
  });
  assert.equal(parsePhase08AcceptanceDatabase(undefined), undefined);
});

test("Phase 08 acceptance database parser rejects wrong host, port, database, role and overrides", () => {
  const cases = [
    accepted.replace("127.0.0.1", "db.example.test"),
    accepted.replace(":56441/", ":5432/"),
    accepted.replace("cloudpilot_acceptance_56441", "cloudpilot_phase08_test"),
    accepted.replace("cloudpilot_acceptance_app", "postgres"),
    `${accepted}?host=127.0.0.1`,
    "not-a-database-url"
  ];
  for (const candidate of cases) assert.throws(() => parsePhase08AcceptanceDatabase(candidate));
});
