import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { getOidcToken } from './oidc';
import { KobeClient } from './client';

export async function post(): Promise<void> {
  const leaseId = core.getState('lease-id');
  const endpoint = core.getState('endpoint');

  if (!leaseId || !endpoint) {
    core.info('No lease to release (claim may have failed)');
    return;
  }

  // Re-mint the OIDC token rather than reusing the one minted in `main`.
  // GitHub Actions runtime ID tokens are short-lived (≲10 min); a job
  // that runs longer than the JWT's lifetime would 401 against an
  // audience-validating server when the cached token is replayed here.
  // Keep this in lockstep with `main.ts` writing `audience` to state.
  const audience = core.getState('audience') || 'kobe-system';

  let token: string;
  try {
    token = await getOidcToken(audience);
  } catch (err) {
    core.warning(
      `Skipping lease release for ${leaseId}: failed to mint OIDC token: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  core.info(`Releasing cluster (lease: ${leaseId})...`);
  const client = new KobeClient(endpoint, token);
  await client.releaseLease(leaseId);

  // Cleanup kubeconfig
  const tmpDir = process.env.RUNNER_TEMP || '/tmp';
  const kubeconfigPath = path.join(tmpDir, `kobe-kubeconfig-${leaseId}`);
  try {
    fs.unlinkSync(kubeconfigPath);
  } catch {
    // ignore
  }
}

if (require.main === module) {
  post();
}
