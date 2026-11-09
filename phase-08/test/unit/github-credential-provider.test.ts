import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import {
  EnvironmentGitHubAppCredentialProvider,
  GitHubAppCredentialConfigurationError,
  type GitHubAppCredentialEnvironment
} from "../../src/github/credential-provider.js";

function validEnvironment(): GitHubAppCredentialEnvironment {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: pair.privateKey,
    GITHUB_APP_WEBHOOK_SECRET: randomBytes(32).toString("base64url")
  };
}

test("environment provider returns typed credentials from injected backend configuration", async () => {
  const environment = validEnvironment();
  const credentials = await new EnvironmentGitHubAppCredentialProvider(environment).getCredentials();
  assert.equal(credentials.appId, 123456);
  assert.equal(credentials.privateKeyPem, environment.GITHUB_APP_PRIVATE_KEY);
  assert.equal(credentials.webhookSecret, environment.GITHUB_APP_WEBHOOK_SECRET);
  assert.ok(Object.isFrozen(credentials));
});

test("environment provider rejects each missing credential with a safe configuration error", async () => {
  for (const variableName of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"] as const) {
    const environment = validEnvironment();
    delete environment[variableName];
    await assert.rejects(
      new EnvironmentGitHubAppCredentialProvider(environment).getCredentials(),
      (error: unknown) => error instanceof GitHubAppCredentialConfigurationError &&
        error.code === "missing" && error.variableName === variableName &&
        !error.message.includes("PRIVATE KEY-----")
    );
  }
});

test("environment provider rejects malformed App IDs, non-RSA or invalid PEM, and weak webhook secrets", async () => {
  const invalidCases: Array<[keyof GitHubAppCredentialEnvironment, string]> = [
    ["GITHUB_APP_ID", "not-an-id"],
    ["GITHUB_APP_PRIVATE_KEY", "not a private key"],
    ["GITHUB_APP_WEBHOOK_SECRET", "too-short"]
  ];
  for (const [variableName, value] of invalidCases) {
    const environment = validEnvironment();
    environment[variableName] = value;
    await assert.rejects(
      new EnvironmentGitHubAppCredentialProvider(environment).getCredentials(),
      (error: unknown) => error instanceof GitHubAppCredentialConfigurationError &&
        error.code === "invalid" && error.variableName === variableName && !error.message.includes(value)
    );
  }

  const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const nonRsa = validEnvironment();
  nonRsa.GITHUB_APP_PRIVATE_KEY = ec.privateKey;
  await assert.rejects(
    new EnvironmentGitHubAppCredentialProvider(nonRsa).getCredentials(),
    (error: unknown) => error instanceof GitHubAppCredentialConfigurationError &&
      error.code === "invalid" && error.variableName === "GITHUB_APP_PRIVATE_KEY"
  );
});

test("environment provider rejects RSA private keys below 2048 bits with a fixed error", async () => {
  const weak = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const environment = validEnvironment();
  environment.GITHUB_APP_PRIVATE_KEY = weak.privateKey;
  await assert.rejects(
    new EnvironmentGitHubAppCredentialProvider(environment).getAppAuthenticationCredentials(),
    (error: unknown) => error instanceof GitHubAppCredentialConfigurationError &&
      error.code === "invalid" && error.variableName === "GITHUB_APP_PRIVATE_KEY" &&
      !error.message.includes(weak.privateKey)
  );
});

test("App authentication credentials can be loaded without retrieving webhook credentials", async () => {
  const environment = validEnvironment();
  delete environment.GITHUB_APP_WEBHOOK_SECRET;
  const provider = new EnvironmentGitHubAppCredentialProvider(environment);
  const credentials = await provider.getAppAuthenticationCredentials();
  assert.equal(credentials.appId, 123456);
  assert.equal(Object.hasOwn(credentials, "webhookSecret"), false);
  await assert.rejects(provider.getWebhookVerificationSecret(), /GITHUB_APP_WEBHOOK_SECRET is required/);
});

test("provider does not log credential material and supports escaped PEM newlines", async () => {
  const environment = validEnvironment();
  environment.GITHUB_APP_PRIVATE_KEY = environment.GITHUB_APP_PRIVATE_KEY!.replace(/\n/g, "\\n");
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => { calls.push(args); };
  console.warn = (...args: unknown[]) => { calls.push(args); };
  console.error = (...args: unknown[]) => { calls.push(args); };
  try {
    const result = await new EnvironmentGitHubAppCredentialProvider(environment).getCredentials();
    assert.match(result.privateKeyPem, /\n/);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(calls), /PRIVATE KEY|GITHUB_APP_WEBHOOK_SECRET/);
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
});
