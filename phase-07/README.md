# CloudPilot Phase 07 — GitHub Remediation & Sandbox Pull Request Automation

Phase 07 implements automated, explainable remediation via GitHub sandbox branches and pull requests, adhering to foundation decisions D-002, D-003, D-009, and D-014.

## Architecture

```
[ Gap Findings (Phase 05 / 06) ]
               │
               ▼
   [ Remediation Planner ] ──── Deterministic & Allowlisted Patches
               │
               ▼
 [ Remediation Orchestrator ] ── PostgreSQL Idempotency Key Check
               │
               ├─► Check Existing GitHub PR (findOpenPullRequest)
               ├─► Create Sandbox Branch from base (e.g. main)
               ├─► Read File Content (or supply standard placeholder)
               ├─► Apply Minimal Allowlisted Patch (idempotent YAML transformation)
               ├─► Commit File with Semantic Message
               └─► Open Draft Pull Request & Persist Outcome
```

## Security & Operational Controls

### 1. Minimal Allowlisted Patching (D-002, D-003)
- Only verified gap findings for allowlisted observability signals (`metric`, `health`, `alert`) produce remediation patches.
- Unsupported signals (`trace`, `log`) and non-gap outcomes (`pass`, `unknown`, `inconclusive`) are safely skipped with explicit audit attribution.
- No arbitrary code or command execution is permitted. File modification is strictly restricted to designated observability configuration paths.

### 2. Path Traversal & Sandbox Protection
- All repository paths, branch names, and repository identifiers are strictly validated against strict regex allowlists before network dispatch.
- Directory traversal sequences (`..`), leading slashes, and control characters are rejected immediately.
- Branches are created under an isolated sandbox prefix (`cloudpilot/remediate/<base64url-hash>`), guaranteeing zero collisions with protected production branches.

### 3. Strict Idempotency & Concurrency Safety
- Every remediation generates a stable idempotency key derived from:
  `${tenantId}:${findingId}:${ruleId}:${ruleVersion}`
- The PostgreSQL `remediations` table enforces a database-level unique constraint (`@unique([idempotencyKey])`).
- Concurrent remediation requests are race-safe: exactly one winner creates the record, while concurrent workers catch `P2002` and cleanly return the active record without creating duplicate branches or PRs.
- `findOpenPullRequest` detects if a GitHub PR is already open for the sandbox branch, reusing the existing PR rather than creating duplicates.

### 4. Bounded Execution & Failure Budget
- Bounded network timeout (default: 10,000ms) and bounded payload sizes (1MB JSON, 2MB file content).
- Token sanitization in all error logs and audit records; tokens are never exposed in exception strings.
- Outbound redirects to non-GitHub domains are unconditionally blocked (`redirect: "error"`).
- Decrementing retry budget (`retries_left`, default 3) transitions persistent failures into terminal `failed` status without unbounded loops.

## Database Schema

```prisma
model Remediation {
  id             String    @id @default(uuid())
  tenantId       String    @map("tenant_id")
  projectId      String    @map("project_id")
  scanId         String    @map("scan_id")
  findingId      String    @map("finding_id")
  idempotencyKey String    @unique @map("idempotency_key")
  status         String    // "pending" | "open" | "merged" | "closed" | "failed"
  branchName     String?   @map("branch_name")
  prNumber       Int?      @map("pr_number")
  prUrl          String?   @map("pr_url")
  patchSummary   String?   @map("patch_summary")
  errorMessage   String?   @map("error_message")
  retriesLeft    Int       @default(3) @map("retries_left")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  project Project @relation(fields: [tenantId, projectId], references: [tenantId, id], onDelete: Cascade)
  scan    Scan    @relation(fields: [tenantId, scanId], references: [tenantId, id], onDelete: Cascade)
  finding Finding @relation(fields: [findingId], references: [id], onDelete: Cascade)
}
```

## Running Tests

### Unit Tests
Unit tests run completely in-process using mocked interfaces (no network or database required):
```bash
npm --prefix phase-07 run test:unit
```

### Integration Tests
Integration tests run against the live local PostgreSQL instance and a local mock GitHub HTTP server:
```bash
npm --prefix phase-07 run test:integration
```
