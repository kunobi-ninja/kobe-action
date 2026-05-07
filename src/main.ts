import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { getOidcToken } from './oidc';
import { KobeClient } from './client';
import { detectBackend, waitForReady } from './readiness';

function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(m|s|h)$/);
  if (!match) return 300000; // default 5m
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h': return value * 3600000;
    case 'm': return value * 60000;
    case 's': return value * 1000;
    default: return 300000;
  }
}

function parseBool(input: string, fallback: boolean): boolean {
  const v = input.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return fallback;
  return fallback;
}

async function run(): Promise<void> {
  try {
    const endpoint = core.getInput('endpoint', { required: true });
    const pool = core.getInput('pool', { required: true });
    const ttl = core.getInput('ttl') || '1h';
    const audience = core.getInput('audience') || 'kobe-system';
    const timeout = parseTimeout(core.getInput('timeout') || '5m');
    // Readiness-wait inputs (default off — backward-compatible: existing
    // consumers see no behavior change).
    const waitReady = parseBool(core.getInput('wait-for-ready'), false);
    const minReadyNodes = parseInt(core.getInput('min-ready-nodes') || '1', 10);
    const readyTimeout = parseTimeout(core.getInput('ready-timeout') || '2m');

    // Get OIDC token
    core.info('Requesting OIDC token...');
    const token = await getOidcToken(audience);

    // Save for post step
    core.saveState('endpoint', endpoint);
    core.saveState('token', token);

    // Create lease
    const client = new KobeClient(endpoint, token);
    core.info(`Claiming cluster from pool "${pool}" with TTL ${ttl}...`);
    const lease = await client.createLease(pool, ttl);

    core.saveState('lease-id', lease.id);
    core.info(`Lease created: ${lease.id}`);

    // Wait for bind if pending
    let boundLease = lease;
    const phase = lease.phase?.toLowerCase();
    if (phase !== 'bound' && phase !== undefined) {
      core.info(`Lease is ${lease.phase}, waiting for cluster assignment...`);
      boundLease = await client.waitForBind(lease.id, timeout);
    }

    const clusterName = boundLease.clusterName || boundLease.cluster_name || '';

    // Write kubeconfig
    let kubeconfig = boundLease.kubeconfig;
    if (!kubeconfig) {
      const refreshed = await client.getLease(lease.id);
      kubeconfig = refreshed.kubeconfig;
    }

    if (!kubeconfig) {
      throw new Error('No kubeconfig returned by Kobe API');
    }

    const tmpDir = process.env.RUNNER_TEMP || '/tmp';
    const kubeconfigPath = path.join(tmpDir, `kobe-kubeconfig-${lease.id}`);
    fs.writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });

    // Always probe the backend — it's free info that lets downstream
    // steps run backend-aware logic without re-querying. Backend detection
    // depends on `kubectl` being on PATH; if it isn't, we surface
    // `unknown` and continue (consumers who don't need this output won't
    // notice).
    const backend = await detectBackend(kubeconfigPath);
    if (backend !== 'unknown') {
      core.info(`Detected cluster backend: ${backend}`);
    }

    // Optional readiness gate. The lease is `Bound` (API server reachable)
    // by this point, but worker Pods may still be registering as Nodes.
    // Tests that hit `kubectl get nodes` immediately can race that window.
    // Auto-discovery: every supported backend reports Node objects with
    // a standard Ready condition, so a single polling loop covers them all.
    if (waitReady) {
      await waitForReady({
        kubeconfig: kubeconfigPath,
        minReadyNodes,
        timeoutMs: readyTimeout,
        backend,
      });
    }

    // Set outputs
    core.setOutput('kubeconfig-path', kubeconfigPath);
    core.setOutput('lease-id', lease.id);
    core.setOutput('cluster-name', clusterName);
    core.setOutput('cluster-backend', backend);

    core.notice(`Cluster ${clusterName} ready (lease: ${lease.id})`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
