import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { KobeClient } from './client';

async function post(): Promise<void> {
  const leaseId = core.getState('lease-id');
  const endpoint = core.getState('endpoint');
  const token = core.getState('token');

  if (!leaseId || !endpoint || !token) {
    core.info('No lease to release (claim may have failed)');
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

post();
