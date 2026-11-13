# CloudPilot Threat Model

**Status:** Initial threat inventory; refine during implementation.

## Assets
Source-control/cloud credentials, source/configuration, telemetry and architecture metadata, tenant data, generated patches, approvals/deployment authority, audit records and policy configuration.

## Assumptions
Repository files, PR comments, telemetry, and external API responses can be malicious. AI output is untrusted. GitHub access does not imply production deployment authority. A merged PR does not prove runtime success.

## Threats and controls
| Threat | Initial control |
|---|---|
| Excessive repository permissions | Scoped GitHub App installation/minimum permissions |
| Secret leakage | Secret manager, redaction, tests against logs and responses |
| Malicious manifests/parser exploit | Safe parser, allowlisted formats, size/depth/time limits, no script execution |
| Prompt injection in repo/telemetry | Treat content as data; model cannot grant permissions or bypass policy |
| Sensitive data exposure to AI/provider tools | Define provider, retention, logging, and data-minimization boundaries before sending repository, telemetry, tenant or credential-adjacent data to any model |
| Unsafe generated patch | Allowlisted paths, bounded diff, patch validation, human review and CI |
| Unauthorized deployment | Server-side RBAC, protected environments, required reviewers/checks, deny by default |
| Cross-tenant access | Per-request authorization, tenant-scoped queries and negative tests |
| Cross-organization IDOR or confused-deputy access | Resolve the local user and organization membership server-side for every scoped request; treat supplied organization IDs as untrusted locators; use organization-scoped queries and negative tests |
| Role leakage between organizations | Load role from the membership for the requested organization; never authorize from a global role claim, frontend state, or a previously selected organization |
| Account takeover through email-based linking | Map external identity by validated `(issuer, subject)`; require deliberate proof of both identities for linking; never automatically link by email |
| Invitation replay or privilege escalation | Store only token hashes; bind invitation to organization, verified email, role and expiry; atomically consume once; audit inviter and acceptance; protect owner transfer |
| Legacy ownership misassignment | Preserve Tenant and resource provenance; do not infer an individual owner from email, tenant membership, or opaque historical actor IDs; require verified bootstrap |
| RLS context bleed through connection pooling | Defer RLS until organization context is transaction-local and proven with Prisma pooling; fail closed without context; use a non-bypass application role and test connection reuse |
| Cross-organization integration credential use | Bind each integration to one organization; verify repository/account access; use short-lived credentials and secret references; test cross-organization denial and revocation |
| Customer target SSRF or network pivot | Do not give shared workers unrestricted customer-controlled network access; define egress and isolation boundaries; test private, loopback, link-local, metadata, redirect, DNS-rebinding, and cross-customer routes |
| Organization deletion removes required audit evidence | Define retention, export, legal hold, soft-delete, and audit lifecycle before enabling deletion; do not assume append-only application writes are tamper-proof |
| Telemetry injection/oversized payload | Escaping, payload/query limits, safe rendering |
| Supply-chain compromise | Lockfiles, dependency/image scanning, provenance plan |
| Denial of service | Rate limits, quotas, timeouts, bounded retries |
| Audit tampering | Restricted write path, append-only model, protected storage/integrity checks |
| False verification | Explicit evidence/time windows; inconclusive is not success |

## Security invariants
1. Read-only scan credentials cannot create branches, merge PRs or deploy.
2. AI output cannot bypass authorization or policy.
3. No unrestricted model-generated command is applied directly to production.
4. Production-impacting operations require recorded authorized approval.
5. Findings/remediations reference evidence and rule/policy versions.
6. Missing evidence is never silently treated as success.
7. Organization membership and permission are checked server-side for every scoped operation; legacy tenant checks remain enforced during migration.
8. Repository, telemetry, tenant and audit data sent to external processors follows an explicit approved data-boundary decision.

## Residual risks
External CI misconfiguration, incorrect/incomplete rules, compromised authorized users/identities, ambiguous legacy ownership, provider account-linking errors, pooled-connection context mistakes, customer network reachability, telemetry privacy/cost, AI/provider data handling, and changing provider APIs require ongoing review. Provider choice, invitation policy, RLS deployment, network isolation, and data-retention controls are not settled merely by this threat inventory.
