import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { getOidcToken } from './oidc';
import { KobeClient } from './client';
import { detectBackend, waitForReady } from './readiness';
import { parseBool, parseDuration, parseNonNegInt } from './inputs';
import { localKubeconfigAlias, rewriteKubeconfigNames } from './kubeconfig';

async function run(): Promise<void> {
  try {
    const endpoint = core.getInput('endpoint', { required: true });
    const pool = core.getInput('pool', { required: true });
    const ttl = core.getInput('ttl') || '1h';
    const audience = core.getInput('audience') || 'kobe-system';
    const timeout = parseDuration(core.getInput('timeout'), 5 * 60_000);
    // Readiness-wait inputs (default off — backward-compatible: existing
    // consumers see no behavior change).
    const waitReady = parseBool(core.getInput('wait-for-ready'), false);
    // Default 0 so single-node k3s/k0s server pools (the most common CI
    // shape) pass the gate without explicit configuration. Multi-node
    // setups should set `min-ready-nodes: 1` (or higher) to require a
    // worker. See README "Waiting for cluster readiness".
    const minReadyNodes = parseNonNegInt(core.getInput('min-ready-nodes'), 0);
    const readyTimeout = parseDuration(core.getInput('ready-timeout'), 2 * 60_000);

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

    // Rewrite the kubeconfig's cluster/context/user names to a friendly
    // `kobe-<pool>-<short-lease-id>` alias before writing to disk. This
    // matches what the kobe CLI does (`rewrite_local_kubeconfig_names`
    // in kobe's `src/cli/commands/lease_create.rs`), so consumers can
    // rely on a stable `kobe-` prefix regardless of which interface
    // (CLI or this action) created the lease. Without this rewrite, the
    // raw API kubeconfig carries `lease-<id>` as the context name, and
    // downstream filters that key off the `kobe-` prefix silently
    // drop it.
    const alias = localKubeconfigAlias(pool, lease.id);
    const rewritten = rewriteKubeconfigNames(kubeconfig, alias);

    const tmpDir = process.env.RUNNER_TEMP || '/tmp';
    const kubeconfigPath = path.join(tmpDir, `${alias}.yaml`);
    fs.writeFileSync(kubeconfigPath, rewritten, { mode: 0o600 });

    // Always probe the backend — it's free info that lets downstream
    // steps run backend-aware logic without re-querying. Failures
    // surface as warnings (not silent) but never fail the action;
    // the `cluster-backend` output is documented as informational.
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
