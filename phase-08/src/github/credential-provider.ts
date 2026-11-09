import { createPrivateKey } from "node:crypto";

/** Credentials used to sign GitHub App JWTs; backend-only. */
export interface GitHubAppAuthenticationCredentials {
  readonly appId: number;
  readonly privateKeyPem: string;
}

/** Compatibility aggregate for callers that explicitly need both purposes. */
export interface GitHubAppCredentials extends GitHubAppAuthenticationCredentials {
  readonly webhookSecret: string;
}

/** Token minting can request only App authentication material. */
export interface GitHubAppAuthenticationCredentialProvider {
  getAppAuthenticationCredentials(): Promise<GitHubAppAuthenticationCredentials>;
}

/** Webhook verification retrieves its independent secret only when needed. */
export interface GitHubWebhookCredentialProvider {
  getWebhookVerificationSecret(): Promise<string>;
}

/** Implementations may retrieve values asynchronously from a secret manager. */
export interface GitHubAppCredentialProvider extends GitHubAppAuthenticationCredentialProvider, GitHubWebhookCredentialProvider {
  /** Backward-compatible aggregate accessor; purpose-specific code should avoid it. */
  getCredentials(): Promise<GitHubAppCredentials>;
}

export interface GitHubAppCredentialEnvironment {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
}

export type GitHubAppCredentialErrorCode = "missing" | "invalid";

/** Error text is fixed/configuration-only and never includes credential contents. */
export class GitHubAppCredentialConfigurationError extends Error {
  constructor(readonly code: GitHubAppCredentialErrorCode, readonly variableName: string) {
    super(code === "missing"
      ? `${variableName} is required for GitHub App credential access.`
      : `${variableName} has an invalid format.`);
    this.name = "GitHubAppCredentialConfigurationError";
  }
}

/**
 * Local development provider. Values are read from the backend process
 * environment only when requested. No credentials are logged or persisted.
 */
export class EnvironmentGitHubAppCredentialProvider implements GitHubAppCredentialProvider {
  constructor(private readonly environment: GitHubAppCredentialEnvironment = process.env as GitHubAppCredentialEnvironment) {}

  async getAppAuthenticationCredentials(): Promise<GitHubAppAuthenticationCredentials> {
    const rawAppId = this.required("GITHUB_APP_ID", this.environment.GITHUB_APP_ID);
    if (!/^[1-9]\d{0,14}$/.test(rawAppId)) {
      throw new GitHubAppCredentialConfigurationError("invalid", "GITHUB_APP_ID");
    }
    const appId = Number(rawAppId);
    if (!Number.isSafeInteger(appId)) {
      throw new GitHubAppCredentialConfigurationError("invalid", "GITHUB_APP_ID");
    }

    const rawPrivateKey = this.required("GITHUB_APP_PRIVATE_KEY", this.environment.GITHUB_APP_PRIVATE_KEY);
    if (Buffer.byteLength(rawPrivateKey, "utf8") > 32_768) {
      throw new GitHubAppCredentialConfigurationError("invalid", "GITHUB_APP_PRIVATE_KEY");
    }
    // Permit the common escaped-newline environment injection form without
    // logging or retaining an additional normalized copy in provider state.
    const privateKeyPem = rawPrivateKey.includes("\\n") && !rawPrivateKey.includes("\n")
      ? rawPrivateKey.replace(/\\n/g, "\n")
      : rawPrivateKey;
    try {
      const key = createPrivateKey(privateKeyPem);
      const modulusLength = key.asymmetricKeyDetails?.modulusLength;
      if (key.asymmetricKeyType !== "rsa" || typeof modulusLength !== "number" || modulusLength < 2048) {
        throw new Error();
      }
    } catch {
      throw new GitHubAppCredentialConfigurationError("invalid", "GITHUB_APP_PRIVATE_KEY");
    }

    return Object.freeze({ appId, privateKeyPem });
  }

  async getWebhookVerificationSecret(): Promise<string> {
    const webhookSecret = this.required("GITHUB_APP_WEBHOOK_SECRET", this.environment.GITHUB_APP_WEBHOOK_SECRET);
    if (webhookSecret.length < 32 || webhookSecret.length > 4096 || /[\u0000-\u001f\u007f]/u.test(webhookSecret)) {
      throw new GitHubAppCredentialConfigurationError("invalid", "GITHUB_APP_WEBHOOK_SECRET");
    }
    return webhookSecret;
  }

  async getCredentials(): Promise<GitHubAppCredentials> {
    const app = await this.getAppAuthenticationCredentials();
    const webhookSecret = await this.getWebhookVerificationSecret();
    return Object.freeze({ ...app, webhookSecret });
  }

  private required(name: string, value: string | undefined): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new GitHubAppCredentialConfigurationError("missing", name);
    }
    return value;
  }
}
