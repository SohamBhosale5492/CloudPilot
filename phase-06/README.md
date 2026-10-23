# CloudPilot Phase 06 — API and Persistence Layer

Phase 06 delivers the authenticated REST API and PostgreSQL persistence layer for CloudPilot, enabling multi-tenant project management, asynchronous gap scans, finding persistence, and audit logging.

## Architecture

CloudPilot Phase 06 is implemented as a modular monolith adhering to foundation decisions D-005 and D-010:
- **Runtime & HTTP**: Zero-dependency `node:http` API server with clean route handling, streaming body parser with byte limits, and typed middleware.
- **Persistence**: PostgreSQL 16 with Prisma ORM. Strict composite tenant constraints and foreign keys guarantee relational tenant isolation.
- **Evaluation Decoupling**: The Gap Engine (`phase-01/demo-service/src/gap-engine.ts`) remains pure, in-memory, and free of persistence logic. The scan runner coordinates inspector evidence gathering, executes the Gap Engine, and persists resulting findings.

## Security Controls

### 1. Authentication & JWT Validation
- Verifies OIDC/JWT tokens using native Node.js cryptography (`RS256` or `HS256`).
- Strict verification of standard claims (`iss`, `aud`, `exp`, `nbf`) and CloudPilot identity claims (`sub`, `tenant_id`, `roles`).
- Rejects malformed tokens, bad signatures, expired tokens, or unassigned roles with HTTP `401 Unauthorized`.
- Dedicated test keypair / token minter (`test/jwt-signer.ts`) for deterministic local testing without production authentication bypasses or backdoors.

### 2. Deny-by-Default RBAC
Server-side role-based access control enforces least privilege across three defined roles:
- **`admin`**: Full tenant management (`project:read`, `project:create`, `project:update`, `project:delete`, `scan:read`, `scan:create`, `finding:read`, `audit:read`).
- **`operator`**: Scan lifecycle execution and inspection (`project:read`, `scan:read`, `scan:create`, `finding:read`).
- **`viewer`**: Read-only observability access (`project:read`, `scan:read`, `finding:read`).

### 3. Tenant Isolation & Resource Enumeration Defense
- Every database query is explicitly scoped by `tenantId`.
- Relational integrity is enforced at the database level using composite unique constraints (`@@unique([tenantId, id])`) on `Project` and `Scan`, with composite foreign keys on related records.
- Cross-tenant resource queries return HTTP `404 Not Found` (never `403 Forbidden`) to prevent enumeration of resources across tenants.

### 4. Secret & Evidence Sanitization
- URLs configured for target repositories or inspection backends are validated and sanitized (`validateAndSanitizeUrl`).
- Userinfo credentials (e.g. `user:password@`) and sensitive query parameters (`token`, `secret`, `key`, `auth`, `sig`) are stripped before storage.
- Error messages are sanitized to prevent stack traces, bearer tokens, or internal infrastructure details from leaking into scan records or API responses.
- The audit log (`audit_events`) is strictly append-only.

## Asynchronous Scan Lifecycle

```
[ POST /api/v1/projects/:id/scans ]
                  │
                  ▼
         [ Check Active Scans ] ─── Active Found ──► HTTP 409 Conflict
                  │ (None Active)
                  ▼
      [ Create Scan (status=pending) ] ──► Returns HTTP 202 Accepted
                  │
                  ▼
         [ Bounded Queue ] ────────── Queue Full ──► HTTP 429 Too Many Requests
                  │
                  ▼
         [ Worker Pool ] ──────────── (Bounded concurrency: 5)
                  │
                  ├─► Set status = running
                  ├─► Collect inspector evidence (Phase 04)
                  ├─► Evaluate expected model via Gap Engine (Phase 05)
                  ├─► Persist GapFindings to database
                  └─► Set status = completed (or failed) + Record audit event
```

### Race-Safe Active Scan Uniqueness
- **Database Level**: A partial unique index prevents concurrent active scans for the same project:
  ```sql
  CREATE UNIQUE INDEX "idx_scans_active_project" ON "scans"("tenant_id", "project_id")
  WHERE status IN ('pending', 'running');
  ```
- **Application Level**: The runner checks active scans before enqueueing, rejecting concurrent requests with HTTP `409 Conflict`.
- **Queue Limits**: Maximum queue capacity is bounded to 50 pending jobs with maximum concurrency of 5 workers.

### Durable PostgreSQL Job Coordination & Concurrency
- **PostgreSQL-Backed Queue**: Scans are persisted in the `scans` table and claimed atomically across worker replicas using `SELECT ... FOR UPDATE SKIP LOCKED`. Memory is not the source of truth.
- **Worker Leases & Heartbeats**: Workers claim scans for a bounded lease duration (default 60s) and periodically update `heartbeat_at` and `lease_expires_at`.
- **Safe Lease Reaper**: A background reaper checks for expired worker leases. Scans whose attempt count is below `max_attempts` are automatically re-queued to `pending`; scans exceeding `max_attempts` transition to terminal `failed`.
- **Safe Multi-Replica Startup**: The legacy blanket termination of active scans on startup has been removed. Booting a new replica safely reclaims only expired leases without disturbing healthy living peers.
- **Stale Worker Safeguard**: Result publication requires worker lease verification in an atomic database transaction. If a worker lost its lease due to timeout or network partition, publication throws `StaleWorkerError` and findings are rejected, ensuring at-least-once execution with idempotent result publication.
- **Attempt-Scoped Findings**: Each finding records `attempt_number`. Findings from aborted previous attempts are purged atomically before publishing the successful attempt.

### Production OIDC Discovery & JWKS Rotation
- Discovers OIDC configuration from the preconfigured trusted issuer (`/.well-known/openid-configuration`) and resolves keys from its validated `jwks_uri`.
- Supports asymmetric algorithms (`RS256`, `ES256` via native P-256 IEEE P1363).
- Unconditionally rejects `none`, `jku`/`x5u` token headers, and symmetric algorithms (`HS256`) in JWKS mode.
- Caches public keys with bounded memory and TTL, and throttles unknown-`kid` refresh requests to prevent outbound fetch abuse and cache-stampede DDoS attacks.
- Strict SSRF policy blocks cloud metadata service endpoints (`169.254.169.254`, `metadata.google.internal`) and unauthorized private IP addresses.

## API Endpoints

| Method | Path | Auth Required | Required Permission | Description |
|---|---|---|---|---|
| `GET` | `/health/liveness` | No | None | Process liveness check (`200 OK`) |
| `GET` | `/health/readiness` | No | None | PostgreSQL connectivity check (`200 OK` or `503 Service Unavailable`) |
| `GET` | `/api/v1/projects` | Yes | `project:read` | List tenant projects (paginated) |
| `POST` | `/api/v1/projects` | Yes | `project:create` | Create a new project |
| `GET` | `/api/v1/projects/:id` | Yes | `project:read` | Get project by ID (`404` if other tenant) |
| `DELETE` | `/api/v1/projects/:id` | Yes | `project:delete` | Delete project (`404` if other tenant) |
| `POST` | `/api/v1/projects/:id/scans` | Yes | `scan:create` | Asynchronously trigger a scan (`202 Accepted`) |
| `GET` | `/api/v1/projects/:id/scans` | Yes | `scan:read` | List scans for project (paginated) |
| `GET` | `/api/v1/projects/:id/scans/:scanId` | Yes | `scan:read` | Get scan status and timestamps |
| `GET` | `/api/v1/projects/:id/scans/:scanId/findings` | Yes | `finding:read` | List evaluated findings for scan |
| `GET` | `/api/v1/audit-events` | Yes | `audit:read` | List tenant audit events (append-only) |

## Development & Testing

### 1. Starting PostgreSQL
Start local PostgreSQL via Docker Compose:
```bash
docker compose -f phase-06/docker-compose.yml up -d
```
Default connection string:
`postgresql://cloudpilot:cloudpilot_password@localhost:5432/cloudpilot_test`

### 2. Running Migrations
```bash
npx --prefix phase-06 prisma migrate deploy
```

### 3. Running Unit Tests
Unit tests validate JWT verification, JWKS discovery, key rotation, unknown-kid throttling, ES256 IEEE-P1363 cryptography, SSRF protection, RBAC deny-by-default, URL sanitization, and durable queue mechanics:
```bash
npm --prefix phase-06 run test:unit
```

### 4. Running Integration Tests
Integration tests run against PostgreSQL (strictly no SQLite substitution). The suite validates multi-worker concurrency, `FOR UPDATE SKIP LOCKED` racing, lease renewal, crash recovery, retry exhaustion, and stale worker protection:
```bash
npm --prefix phase-06 run test:integration
```

## Known Limitations & Deferred Capabilities
- **Distributed Broker**: Employs PostgreSQL `FOR UPDATE SKIP LOCKED` coordination instead of Redis/Celery. External distributed messaging brokers remain deferred until operational load requires dedicated message queuing.
- **Dynamic JWKS Rotation Over External Network**: Tests run hermetically with mock OIDC discovery and JWKS servers; production deployment requires internet connectivity to the configured identity provider.
- **Remediation & Mutation**: Phase 06 persists findings only; code patching and GitHub pull request creation are deferred to Phase 07.
