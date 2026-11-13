[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$migrationName = "20261110120000_allow_mutation_rejection_resource_type"
$containerName = "cloudpilot-postgres-acceptance-20261108"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$phaseRoot = Join-Path $repositoryRoot "phase-08"
$schemaSource = Join-Path $phaseRoot "prisma\schema.prisma"
$migrationSource = Join-Path $phaseRoot "prisma\migrations"
$migrationLockSource = Join-Path $migrationSource "migration_lock.toml"
$prismaCommand = Join-Path $phaseRoot "node_modules\.bin\prisma.cmd"
$nodeCommand = (Get-Command node -ErrorAction Stop).Source

$databaseTargets = @(
    [pscustomobject]@{ Variable = "CLOUDPILOT_PHASE08_TEST_DATABASE_URL"; Name = "cloudpilot_phase08_test"; User = "cloudpilot_phase08_test"; Port = 56432 },
    [pscustomobject]@{ Variable = "CLOUDPILOT_CLAIM_TEST_DATABASE_URL"; Name = "cloudpilot_claim_test"; User = "cloudpilot_claim_test"; Port = 56433 },
    [pscustomobject]@{ Variable = "CLOUDPILOT_CLAIM_CONCURRENCY_TEST_DATABASE_URL"; Name = "cloudpilot_claim_concurrency_test"; User = "cloudpilot_claim_concurrency_test"; Port = 56434 },
    [pscustomobject]@{ Variable = "CLOUDPILOT_RECOVERY_LEASE_TEST_DATABASE_URL"; Name = "cloudpilot_recovery_lease_test"; User = "cloudpilot_recovery_lease_test"; Port = 56435 }
)

$expectedMigrations = @(
    "20261014000000_init",
    "20261023000000_durable_jobs",
    "20261023100000_remediation",
    "20261023110000_remediation_composite_fk",
    "20261030100000_remediation_worker_leases",
    "20261030110000_remediation_lease_token",
    "20261101120000_saas_identity_organizations",
    "20261101130000_phase06_scan_lease_token",
    "20261101140000_organization_project_ownership_foundation",
    "20261105120000_github_integration_persistence",
    "20261105150000_remediation_approval_foundation",
    "20261105160000_remediation_execution_artifact",
    "20261106120000_remediation_execution_persistence",
    "20261107130000_system_recovery_lease",
    "20261108120000_remote_mutation_rejected",
    "20261109120000_remediation_execution_retry",
    $migrationName
)
$previousMigrations = @($expectedMigrations | Select-Object -First 16)
$expectedResourceTypesBefore = @("blob", "tree", "commit", "branch", "pull_request", "pull_request_close")
$expectedResourceTypesAfter = @($expectedResourceTypesBefore + "github_mutation")

function Stop-Safely([string]$Message) {
    throw $Message
}

function Get-ApprovedTarget([pscustomobject]$Target) {
    $processValue = [Environment]::GetEnvironmentVariable($Target.Variable, "Process")
    if ([string]::IsNullOrWhiteSpace($processValue)) {
        $secret = Read-Host -Prompt "Enter the approved URL for $($Target.Name) at 127.0.0.1:$($Target.Port) (hidden input)" -AsSecureString
    } else {
        try { $secret = ConvertTo-SecureString -String $processValue -AsPlainText -Force }
        catch { $processValue = $null; Stop-Safely "$($Target.Variable) could not be secured in memory. No database was contacted." }
        $processValue = $null
    }
    if ($null -eq $secret -or $secret.Length -eq 0) {
        if ($secret) { $secret.Dispose() }
        Stop-Safely "No URL was supplied for $($Target.Name). No database was contacted."
    }

    $pointer = [IntPtr]::Zero
    $urlText = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $urlText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($urlText -cne $urlText.Trim() -or $urlText -match '\s') {
            $secret.Dispose()
            Stop-Safely "$($Target.Variable) contains whitespace or control characters. Its value was not displayed; no database was contacted."
        }
        try { $uri = [System.Uri]::new($urlText) }
        catch {
            $secret.Dispose()
            Stop-Safely "$($Target.Variable) is malformed. Its value was not displayed; no database was contacted."
        }

        $username = [System.Uri]::UnescapeDataString($uri.UserInfo.Split(":")[0])
        $databaseName = [System.Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
        $decodedQuery = [System.Uri]::UnescapeDataString($uri.Query)
        $overrideKeys = @("host", "hostaddr", "port", "dbname", "database", "user", "username")
        $hasOverride = $false
        foreach ($key in $overrideKeys) {
            if ($decodedQuery -match "(?i)(?:\?|&)$([regex]::Escape($key))=") { $hasOverride = $true }
        }
        if ($uri.Scheme -notin @("postgres", "postgresql") -or
            $uri.Host -ne "127.0.0.1" -or
            $uri.Port -ne $Target.Port -or
            $databaseName -ne $Target.Name -or
            $username -ne $Target.User -or
            $uri.Fragment -or $hasOverride) {
            $secret.Dispose()
            Stop-Safely "$($Target.Variable) does not identify its approved loopback host, port, database and user. No database was contacted."
        }
        return ,$secret
    } catch {
        if ($secret -and $secret.Length -gt 0) { $secret.Dispose() }
        throw
    } finally {
        $urlText = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}

function Test-UrlPasswordMatch([SecureString]$DatabaseUrl, [SecureString]$ExpectedPassword) {
    $urlPointer = [IntPtr]::Zero
    $passwordPointer = [IntPtr]::Zero
    $urlText = $null
    $expectedText = $null
    $actualText = $null
    $actualBytes = $null
    $expectedBytes = $null
    $actualHash = $null
    $expectedHash = $null
    try {
        $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DatabaseUrl)
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ExpectedPassword)
        $urlText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
        $expectedText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        $uri = [System.Uri]::new($urlText)
        $separator = $uri.UserInfo.IndexOf(':')
        if ($separator -lt 0) { return $false }
        $actualText = [System.Uri]::UnescapeDataString($uri.UserInfo.Substring($separator + 1))
        $actualBytes = [System.Text.Encoding]::UTF8.GetBytes($actualText)
        $expectedBytes = [System.Text.Encoding]::UTF8.GetBytes($expectedText)
        if ($actualBytes.Length -ne $expectedBytes.Length) { return $false }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $actualHash = $sha.ComputeHash($actualBytes)
            $expectedHash = $sha.ComputeHash($expectedBytes)
            $difference = 0
            for ($index = 0; $index -lt $actualHash.Length; $index++) {
                $difference = $difference -bor ($actualHash[$index] -bxor $expectedHash[$index])
            }
            return ($difference -eq 0)
        } finally { $sha.Dispose() }
    } finally {
        foreach ($buffer in @($actualBytes, $expectedBytes, $actualHash, $expectedHash)) {
            if ($buffer -is [byte[]]) { [Array]::Clear($buffer, 0, $buffer.Length) }
        }
        $urlText = $null; $expectedText = $null; $actualText = $null
        if ($urlPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer) }
        if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    }
}

function Invoke-IdentityCheck([string]$NodePath, [string]$HelperPath, [string]$ClientModule,
    [pscustomobject]$Target, [SecureString]$DatabaseUrl, [int]$ExpectedCount, [string]$Mode, [string]$MigrationFile) {
    $previousUrl = [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
    $pointer = [IntPtr]::Zero
    $urlText = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DatabaseUrl)
        $urlText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        [Environment]::SetEnvironmentVariable("DATABASE_URL", $urlText, "Process")
        & $NodePath $HelperPath $ClientModule $Target.Name $Target.User ([string]$Target.Port) `
            ([string]$ExpectedCount) $Mode $MigrationFile
        $checkExitCode = $LASTEXITCODE
    } finally {
        [Environment]::SetEnvironmentVariable("DATABASE_URL", $previousUrl, "Process")
        $urlText = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    if ($checkExitCode -ne 0) {
        Stop-Safely "$Mode identity/schema check failed for $($Target.Name). The database was not advanced by this check."
    }
}

function Invoke-PrismaCommand([SecureString]$DatabaseUrl, [string[]]$Arguments) {
    $previousUrl = [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
    $pointer = [IntPtr]::Zero
    $urlText = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DatabaseUrl)
        $urlText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        [Environment]::SetEnvironmentVariable("DATABASE_URL", $urlText, "Process")
        $commandOutput = @(& $prismaCommand @Arguments 2>&1)
        $commandExitCode = $LASTEXITCODE
        $loadedEnvironmentFile = ($commandOutput -join "`n") -match "(?i)environment variables loaded from"
        $isUpToDate = ($commandOutput -join "`n") -match "(?i)up.to.date"
    } finally {
        [Environment]::SetEnvironmentVariable("DATABASE_URL", $previousUrl, "Process")
        $urlText = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $commandOutput = $null
    }
    return [pscustomobject]@{
        ExitCode = $commandExitCode
        LoadedEnvironmentFile = $loadedEnvironmentFile
        UpToDate = $isUpToDate
    }
}

$oldDatabaseUrl = [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
$workspaceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudpilot-migration-" + [guid]::NewGuid().ToString("N"))
$workspaceCreated = $false
$scriptExitCode = 0
$safeStage = "startup"
$approvedUrls = @{}

try {
    Write-Host "Preflight: checking approved process variables, Docker container, mappings and migration files."

    foreach ($target in $databaseTargets) {
        $approvedUrls[$target.Variable] = Get-ApprovedTarget $target
    }

    $safeStage = "shared_password_prompt"
    $expectedDatabasePassword = Read-Host -Prompt "Enter the shared database password used for direct psql authentication (hidden input)" -AsSecureString
    if ($null -eq $expectedDatabasePassword -or $expectedDatabasePassword.Length -eq 0) {
        Stop-Safely "No shared database password was supplied. No database was contacted."
    }
    $safeStage = "url_password_comparison"
    foreach ($target in $databaseTargets) {
        if (-not (Test-UrlPasswordMatch $approvedUrls[$target.Variable] $expectedDatabasePassword)) {
            Stop-Safely "The password embedded in the approved URL for $($target.Name) does not match the shared-password prompt. No database was contacted."
        }
        Write-Host "Credential comparison passed for $($target.Name); password and fingerprint were not logged."
    }
    $expectedDatabasePassword.Dispose()
    $expectedDatabasePassword = $null
    $safeStage = "docker_preflight"

    $dockerVersion = & docker info --format "{{.ServerVersion}}" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($dockerVersion -join ""))) {
        Stop-Safely "Docker is unavailable. No database was contacted."
    }
    $containerState = & docker inspect $containerName --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}" 2>$null
    if ($LASTEXITCODE -ne 0 -or ($containerState -join "").Trim() -ne "running|healthy") {
        Stop-Safely "The authorized acceptance container is not running and healthy. No database was contacted."
    }
    $actualMappings = @(& docker port $containerName "5432/tcp" 2>$null | ForEach-Object { $_.Trim() } | Sort-Object)
    $expectedMappings = @($databaseTargets | ForEach-Object { "127.0.0.1:$($_.Port)" } | Sort-Object)
    if ($LASTEXITCODE -ne 0 -or ($actualMappings -join "`n") -ne ($expectedMappings -join "`n")) {
        Stop-Safely "The acceptance container port mappings differ from the four approved loopback ports. No database was contacted."
    }

    if (-not (Test-Path -LiteralPath $schemaSource -PathType Leaf) -or
        -not (Test-Path -LiteralPath $migrationLockSource -PathType Leaf) -or
        -not (Test-Path -LiteralPath $prismaCommand -PathType Leaf)) {
        Stop-Safely "The canonical Phase 08 Prisma schema, migration lock or local Prisma CLI is missing. No database was contacted."
    }
    $actualMigrations = @(Get-ChildItem -LiteralPath $migrationSource -Directory | Sort-Object Name | Select-Object -ExpandProperty Name)
    if (($actualMigrations -join "`n") -ne ($expectedMigrations -join "`n")) {
        Stop-Safely "The repository migration sequence differs from the approved 17-migration history. No database was contacted."
    }
    foreach ($target in $databaseTargets) {
        Write-Host "Preflight: target configuration validated for $($target.Name) at 127.0.0.1:$($target.Port)."
    }

    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedWorkspace = [System.IO.Path]::GetFullPath($workspaceRoot)
    if (-not $resolvedWorkspace.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedWorkspace.StartsWith($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-Path -LiteralPath $resolvedWorkspace)) {
        Stop-Safely "The temporary workspace path is not a fresh path outside the repository."
    }
    [void][System.IO.Directory]::CreateDirectory($resolvedWorkspace)
    $workspaceCreated = $true
    $tempPrisma = Join-Path $resolvedWorkspace "prisma"
    $tempMigrations = Join-Path $tempPrisma "migrations"
    [void][System.IO.Directory]::CreateDirectory($tempMigrations)
    Copy-Item -LiteralPath $schemaSource -Destination (Join-Path $tempPrisma "schema.prisma")
    Copy-Item -LiteralPath $migrationLockSource -Destination (Join-Path $tempMigrations "migration_lock.toml")
    foreach ($migration in $actualMigrations) {
        Copy-Item -LiteralPath (Join-Path $migrationSource $migration) -Destination $tempMigrations -Recurse
    }

    $tempSchema = Join-Path $tempPrisma "schema.prisma"
    $helperPath = Join-Path $resolvedWorkspace "verify-database.cjs"
    $helperSource = @'
const path = require("node:path");
const { createRequire } = require("node:module");
const requireFromPackage = createRequire(path.join(process.argv[2], "package.json"));
const { PrismaClient } = requireFromPackage("@prisma/client");
const [databaseName, expectedUser, expectedHostPort, expectedCountText, mode, migrationJson] = process.argv.slice(3);
const expectedCount = Number(expectedCountText);
const expectedMigrations = JSON.parse(require("node:fs").readFileSync(migrationJson, "utf8"));
const beforeTypes = ["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"];
const afterTypes = [...beforeTypes, "github_mutation"];
const safeFailureCategories = new Set([
  "DATABASE_CONNECT_FAILED", "DATABASE_AUTHENTICATION_FAILED", "DATABASE_CONNECTION_REFUSED",
  "DATABASE_CONNECTION_TIMEOUT", "DATABASE_HOST_UNREACHABLE", "DATABASE_IDENTITY_QUERY_FAILED", "DATABASE_IDENTITY_MISMATCH",
  "MIGRATION_QUERY_FAILED", "MIGRATION_COUNT_MISMATCH", "MIGRATION_HISTORY_MISMATCH",
  "CONSTRAINT_QUERY_FAILED", "CONSTRAINT_NOT_FOUND", "CONSTRAINT_NOT_VALIDATED",
  "CONSTRAINT_DEFINITION_MISMATCH", "DATABASE_QUERY_FAILED"
]);
let activeStage = "startup";

function fail(category, sqlState = "unavailable") {
  const error = new Error(category);
  error.safeCategory = category;
  error.safeStage = activeStage;
  error.safeSqlState = typeof sqlState === "string" && /^[0-9A-Z]{5}$/i.test(sqlState)
    ? sqlState.toUpperCase()
    : "unavailable";
  throw error;
}

function extractSqlState(error) {
  const candidates = [error?.meta?.code, error?.code, error?.cause?.meta?.code, error?.cause?.code];
  const state = candidates.find((value) => typeof value === "string" && /^[0-9A-Z]{5}$/i.test(value));
  return state ? state.toUpperCase() : "unavailable";
}

function safeConnectCategory(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const codes = [current.code, current.errorCode, current.meta?.code];
    if (codes.includes("P1000")) return "DATABASE_AUTHENTICATION_FAILED";
    if (codes.includes("ECONNREFUSED")) return "DATABASE_CONNECTION_REFUSED";
    if (codes.some((code) => ["ETIMEDOUT", "ESOCKETTIMEDOUT", "P1002"].includes(code))) return "DATABASE_CONNECTION_TIMEOUT";
    if (codes.some((code) => ["EHOSTUNREACH", "ENETUNREACH", "P1001"].includes(code))) return "DATABASE_HOST_UNREACHABLE";
    pending.push(current.cause, current.originalError, current.meta?.cause);
  }
  return "DATABASE_CONNECT_FAILED";
}

function checkConstraint(definition, allowed) {
  const normalized = definition.toLowerCase()
    .replace(/^\s*check\s*/i, "")
    .replace(/::\s*(?:text|character\s+varying)\b\s*(?:\[\])?/gi, "")
    .replace(/["\s()]/g, "");
  const expected = `remote_resource_typeisnullorremote_resource_type=anyarray[${allowed.map((v) => `'${v}'`).join(",")}]`;
  return normalized === expected;
}

(async () => {
  activeStage = "url_validation";
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) fail("DATABASE_IDENTITY_MISMATCH");
  let url;
  try { url = new URL(rawUrl); } catch { fail("DATABASE_IDENTITY_MISMATCH"); }
  let username;
  let database;
  try {
    username = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch { fail("DATABASE_IDENTITY_MISMATCH"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
       url.hostname !== "127.0.0.1" ||
      url.port !== expectedHostPort || database !== databaseName || username !== expectedUser || url.hash) {
    fail("DATABASE_IDENTITY_MISMATCH");
  }

  const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });
  try {
    activeStage = "database_connect";
    try { await prisma.$connect(); } catch (error) { fail(safeConnectCategory(error), extractSqlState(error)); }
    let identity;
    activeStage = "identity_query";
    try {
      identity = await prisma.$queryRaw`
        SELECT current_database() AS database, current_user AS username, inet_server_port() AS server_port
      `;
    } catch (error) { fail("DATABASE_QUERY_FAILED", extractSqlState(error)); }
    activeStage = "identity_validation";
    if (identity.length !== 1 || identity[0].database !== databaseName || identity[0].username !== expectedUser || Number(identity[0].server_port) !== 5432) {
      fail("DATABASE_IDENTITY_MISMATCH");
    }

    let history;
    activeStage = "migration_history_query";
    try {
      history = await prisma.$queryRaw`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations" ORDER BY started_at
      `;
    } catch (error) { fail("DATABASE_QUERY_FAILED", extractSqlState(error)); }
    activeStage = "migration_count_validation";
    if (history.length !== expectedCount) fail("MIGRATION_COUNT_MISMATCH");
    activeStage = "migration_history_validation";
    if (history.some((row, index) =>
      row.migration_name !== expectedMigrations[index] || row.finished_at === null || row.rolled_back_at !== null)) {
      fail("MIGRATION_HISTORY_MISMATCH");
    }

    let constraints;
    activeStage = "constraint_catalog_query";
    try {
      constraints = await prisma.$queryRaw`
        SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'remediation_execution_events'
          AND c.conname = 'ck_remediation_execution_events_remote_type'
          AND c.contype = 'c'
      `;
    } catch (error) { fail("DATABASE_QUERY_FAILED", extractSqlState(error)); }
    activeStage = "constraint_definition_validation";
    const allowed = mode === "pre" ? beforeTypes : afterTypes;
    if (constraints.length === 0) fail("CONSTRAINT_NOT_FOUND");
    if (constraints.length !== 1) fail("CONSTRAINT_DEFINITION_MISMATCH");
    if (constraints[0].validated !== true) fail("CONSTRAINT_NOT_VALIDATED");
    if (!checkConstraint(constraints[0].definition, allowed)) fail("CONSTRAINT_DEFINITION_MISMATCH");
    process.stdout.write(`CHECK_OK ${databaseName} ${mode} migrations=${expectedCount} constraint=verified\n`);
  } finally {
    activeStage = "database_disconnect";
    await prisma.$disconnect();
  }
})().catch((error) => {
  const category = error && safeFailureCategories.has(error.safeCategory)
    ? error.safeCategory
    : "DATABASE_QUERY_FAILED";
  const stage = typeof error?.safeStage === "string" && /^[a-z_]{1,48}$/.test(error.safeStage)
    ? error.safeStage
    : activeStage;
  const sqlState = typeof error?.safeSqlState === "string" && /^[0-9A-Z]{5}$/.test(error.safeSqlState)
    ? error.safeSqlState
    : "unavailable";
  process.stderr.write(`CHECK_FAILED ${databaseName} ${mode} stage=${stage} category=${category} sqlstate=${sqlState}; details suppressed\n`);
  process.exitCode = 1;
});
'@
    [System.IO.File]::WriteAllText($helperPath, $helperSource, [System.Text.UTF8Encoding]::new($false))
    if ((Test-Path -LiteralPath (Join-Path $resolvedWorkspace ".env")) -or
        (Test-Path -LiteralPath (Join-Path $tempPrisma ".env"))) {
        Stop-Safely "Temporary migration workspace unexpectedly contains an environment file; refusing to invoke Prisma."
    }
    $clientModule = Join-Path $phaseRoot "node_modules\@prisma\client"
    $migrationJson = Join-Path $resolvedWorkspace "expected-migrations.json"
    $previousMigrationJson = Join-Path $resolvedWorkspace "expected-previous-migrations.json"
    [System.IO.File]::WriteAllText($migrationJson, (ConvertTo-Json -InputObject @($expectedMigrations) -Compress), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($previousMigrationJson, (ConvertTo-Json -InputObject @($previousMigrations) -Compress), [System.Text.UTF8Encoding]::new($false))

    Write-Host "Preflight: verifying the approved split migration state for all four targets before any migration."
    foreach ($target in $databaseTargets) {
        if ($target.Name -eq "cloudpilot_phase08_test") {
            Invoke-IdentityCheck $nodeCommand $helperPath $clientModule $target $approvedUrls[$target.Variable] 17 "post" $migrationJson
        } else {
            Invoke-IdentityCheck $nodeCommand $helperPath $clientModule $target $approvedUrls[$target.Variable] 16 "pre" $previousMigrationJson
        }
    }
    Write-Host "Preflight passed for all four databases. No migrations have been applied yet."

    $pendingTargets = @($databaseTargets | Where-Object { $_.Name -ne "cloudpilot_phase08_test" })
    if ($pendingTargets.Count -ne 3 -or $pendingTargets.Name -contains "cloudpilot_phase08_test") {
        Stop-Safely "Pending migration target selection did not match the approved three-database set. No migration was applied."
    }

    $schemaValidation = $null
    $safeStage = "schema_validation"
    Push-Location $resolvedWorkspace
    try {
        $schemaValidation = Invoke-PrismaCommand $approvedUrls[$databaseTargets[0].Variable] @("validate", "--schema", $tempSchema)
        if ($schemaValidation.LoadedEnvironmentFile) { Stop-Safely "Prisma reported loading an environment file; refusing further commands. No migrations were applied." }
        if ($schemaValidation.ExitCode -ne 0) { Stop-Safely "Prisma schema validation failed in the isolated temporary workspace. No migrations were applied." }
    } finally { Pop-Location }
    Write-Host "Prisma schema validation passed from the temporary workspace."

    foreach ($target in $pendingTargets) {
        $safeStage = "migration_precheck"
        Write-Host "Applying only the sole pending migration to $($target.Name)."
        Push-Location $resolvedWorkspace
        try {
            # Recheck this target immediately before its only authorized write.
            Invoke-IdentityCheck $nodeCommand $helperPath $clientModule $target $approvedUrls[$target.Variable] 16 "pre" $previousMigrationJson
            $safeStage = "migration_deploy"
            $deployResult = Invoke-PrismaCommand $approvedUrls[$target.Variable] @("migrate", "deploy", "--schema", $tempSchema)
            if ($deployResult.LoadedEnvironmentFile) {
                Stop-Safely "Prisma reported loading an environment file; no further migration commands will run."
            }
            if ($deployResult.ExitCode -ne 0) {
                Stop-Safely "Prisma deploy failed for $($target.Name). No migration was attempted on later databases. CLI output suppressed."
            }
            $safeStage = "migration_status"
            $statusResult = Invoke-PrismaCommand $approvedUrls[$target.Variable] @("migrate", "status", "--schema", $tempSchema)
            if ($statusResult.LoadedEnvironmentFile) {
                Stop-Safely "Prisma reported loading an environment file during status; refusing further commands."
            }
            if ($statusResult.ExitCode -ne 0 -or -not $statusResult.UpToDate) {
                Stop-Safely "Prisma migrate status did not report an up-to-date schema for $($target.Name). CLI output suppressed."
            }
        } finally { Pop-Location }

        $safeStage = "target_postcheck"
        Invoke-IdentityCheck $nodeCommand $helperPath $clientModule $target $approvedUrls[$target.Variable] 17 "post" $migrationJson
        Write-Host "Verified $($target.Name): 17 migrations applied, no pending migrations, updated CHECK constraint present."
    }

    Write-Host "Verifying final 17-migration state on all four databases."
    $safeStage = "final_verification"
    foreach ($target in $databaseTargets) {
        Invoke-IdentityCheck $nodeCommand $helperPath $clientModule $target $approvedUrls[$target.Variable] 17 "post" $migrationJson
    }
    Write-Host "Complete: all four databases have 17 successful migrations and the validated CHECK constraint."
}
catch {
    Write-Host "ERROR: Migration runner stopped at stage=$safeStage. Detailed error text is suppressed to prevent accidental disclosure of connection data. No URL value was printed." -ForegroundColor Red
    $scriptExitCode = 1
}

finally {
    [Environment]::SetEnvironmentVariable("DATABASE_URL", $oldDatabaseUrl, "Process")
    foreach ($secureUrl in $approvedUrls.Values) {
        if ($secureUrl -is [SecureString]) { $secureUrl.Dispose() }
    }
    if ($expectedDatabasePassword -is [SecureString]) { $expectedDatabasePassword.Dispose() }
    $approvedUrls.Clear()
    $oldDatabaseUrl = $null
    if ($workspaceCreated -and (Test-Path -LiteralPath $workspaceRoot)) {
        $resolvedWorkspace = [System.IO.Path]::GetFullPath($workspaceRoot)
        $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if ($resolvedWorkspace.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $resolvedWorkspace.StartsWith($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            try {
                Remove-Item -LiteralPath $resolvedWorkspace -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Warning "Temporary workspace cleanup failed after command completion; migration status is unchanged. Remove the script-created temporary workspace manually after closing remaining processes."
            }
        }
    }
}

if ($scriptExitCode -ne 0) { exit $scriptExitCode }
