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
7. Tenant/project authorization is checked server-side for every scoped operation.
8. Repository, telemetry, tenant and audit data sent to external processors follows an explicit approved data-boundary decision.

## Residual risks
External CI misconfiguration, incorrect/incomplete rules, compromised authorized users/identities, telemetry privacy/cost, AI/provider data handling, and changing provider APIs require ongoing review.
