// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// electron-builder win.signtoolOptions.sign hook — signs Windows artifacts
// via Microsoft's `dotnet sign` CLI against Azure Trusted Signing.
//
// Why a custom hook instead of electron-builder's native azureSignOptions:
// the native path uses Azure SDK's EnvironmentCredential, which only accepts
// AZURE_CLIENT_SECRET / AZURE_CLIENT_CERTIFICATE_PATH / AZURE_USERNAME+PASSWORD —
// no OIDC federated-token support and no `az login` support. The dotnet `sign`
// CLI uses DefaultAzureCredential, which chains in WorkloadIdentityCredential
// (federated-aware, used in CI via azure/login@v2) and AzureCliCredential
// (`az login`-aware, used locally). Same auth mechanism, two transparent paths.
//
// Behavior:
//   - All three Azure env vars set → sign via `sign code trusted-signing -v ...`.
//   - Any missing + CI=true → fail the build (closes silent-unsigned-CI hole).
//   - Any missing + not in CI → log a "skipping signing" warning and return.
//   - SIGN_DRY_RUN=1 → print the command line that would run, return success
//     without invoking `sign`. Used to verify the signing command on a host
//     where the signing tool is not installed.

'use strict';

const { spawn } = require('node:child_process');

const REQUIRED_ENV = [
  'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_CODE_SIGNING_ACCOUNT_NAME',
  'AZURE_CERT_PROFILE_NAME',
];

const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

const SIGN_INSTALL_HINT =
  "dotnet tool install --global sign --version 0.9.1-beta.25575.4 " +
  "(verify latest beta against https://nuget.org/packages/sign before pinning)";

function quoteForLog(s) {
  return /[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : s;
}

function runSign(args) {
  return new Promise((resolve, reject) => {
    // spawn() on Windows applies PATHEXT to resolve `sign` -> `sign.exe`.
    // Args are passed as an array, no shell quoting required.
    const child = spawn('sign', args, { stdio: 'inherit' });

    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(
          "[sign-windows] 'sign' CLI not found on PATH. Install with: " +
          SIGN_INSTALL_HINT
        ));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[sign-windows] sign tool exited with status ${code}`));
    });
  });
}

async function signWindows(configuration) {
  const filePath = configuration && configuration.path;
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('[sign-windows] electron-builder did not provide a file path in configuration');
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    const inCI = process.env.CI === 'true';
    if (inCI) {
      throw new Error(
        `[sign-windows] CI build is missing required env vars: ${missing.join(', ')}. ` +
        `Refusing to ship an unsigned binary — would brick auto-update for existing installs ` +
        `once win.verifyUpdateCodeSignature is enabled. ` +
        `Configure the signing secrets in your CI environment, or unset CI=true to skip.`
      );
    }
    console.warn(
      `[sign-windows] Skipping signing for ${filePath} — missing env: ${missing.join(', ')}. ` +
      `(Local dev/PR builds remain unsigned; this is expected outside CI.)`
    );
    return;
  }

  // Subcommand is `artifact-signing` (the prior `trusted-signing` subcommand
  // is marked obsolete in `sign --help`; the CLI was renamed to "Artifact
  // Signing" to cover Trusted Signing + other Azure code-signing scenarios
  // under one umbrella). The Azure service brand is still "Trusted Signing"
  // — that's why our env vars keep the AZURE_TRUSTED_SIGNING_* prefix; they
  // map to values copied from the Trusted Signing account blade.
  // Verbosity flag takes a level (not a boolean toggle): Information shows
  // file-by-file progress + auth method selected; bump to Debug or Trace
  // when diagnosing auth chain failures.
  const args = [
    'code',
    'artifact-signing',
    '-v', process.env.SIGN_VERBOSITY || 'Information',
    '--artifact-signing-endpoint', process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
    '--artifact-signing-account', process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
    '--artifact-signing-certificate-profile', process.env.AZURE_CERT_PROFILE_NAME,
    '--file-digest', 'SHA256',
    '--timestamp-url', TIMESTAMP_URL,
    filePath,
  ];

  if (process.env.SIGN_DRY_RUN === '1') {
    console.log(
      '[sign-windows] DRY RUN: would invoke: sign ' +
      args.map(quoteForLog).join(' ')
    );
    return;
  }

  console.log(`[sign-windows] Signing ${filePath}`);
  await runSign(args);
}

exports.default = signWindows;

// Allow direct CLI invocation for a dry-run verification:
//   SIGN_DRY_RUN=1 \
//     AZURE_TRUSTED_SIGNING_ENDPOINT=https://eus.codesigning.azure.net/ \
//     AZURE_CODE_SIGNING_ACCOUNT_NAME=test-account \
//     AZURE_CERT_PROFILE_NAME=test-profile \
//     node build/sign-windows.cjs C:\\path\\to\\file.exe
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node build/sign-windows.cjs <path-to-file>');
    console.error('Required env: ' + REQUIRED_ENV.join(', '));
    console.error('Optional env: SIGN_DRY_RUN=1 (print command, do not sign)');
    process.exit(1);
  }
  signWindows({ path: filePath }).then(
    () => process.exit(0),
    (err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  );
}
