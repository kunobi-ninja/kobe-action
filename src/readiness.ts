import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Note: execFile is the shell-injection-safe form (args passed as a list,
// not interpolated into a shell). We deliberately do NOT use exec().
const runFile = promisify(execFile);

/**
 * Coarse classification of the cluster's underlying distro / backend.
 * Inferred from `serverVersion.gitVersion` reported by the API server.
 *
 * `unknown` is a valid value — readiness logic doesn't branch on backend
 * (every backend exposes Node objects with the same Ready condition), so
 * an unknown backend is informational only and doesn't fail the check.
 */
export type ClusterBackend = 'k3s' | 'k0s' | 'kind' | 'vcluster' | 'capi' | 'kubernetes' | 'unknown';

interface NodeListResult {
  items: Array<{
    metadata?: { name?: string; labels?: Record<string, string> };
    status?: {
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

interface VersionResult {
  serverVersion?: { gitVersion?: string };
}

async function kubectl(args: string[], kubeconfig: string): Promise<{ stdout: string; stderr: string }> {
  return runFile('kubectl', ['--kubeconfig', kubeconfig, ...args], {
    encoding: 'utf-8',
    // Don't inherit caller's KUBECONFIG — the action's kubeconfig is the
    // single source of truth for what cluster we're probing.
    env: { ...process.env, KUBECONFIG: kubeconfig },
  });
}

/**
 * Detect the cluster's backend by inspecting the API server's
 * `gitVersion` string. Returns `unknown` if no recognized marker is found
 * (still valid — readiness check is backend-agnostic).
 */
export async function detectBackend(kubeconfig: string): Promise<ClusterBackend> {
  try {
    const { stdout } = await kubectl(['version', '-o', 'json'], kubeconfig);
    const parsed = JSON.parse(stdout) as VersionResult;
    const gitVersion = parsed.serverVersion?.gitVersion ?? '';
    return classifyGitVersion(gitVersion);
  } catch (err) {
    core.debug(`Backend detection failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  }
}

export function classifyGitVersion(gitVersion: string): ClusterBackend {
  // gitVersion examples:
  //   k3s:       "v1.31.4+k3s1"
  //   k0s:       "v1.31.4+k0s"
  //   kind:      "v1.31.0" (no marker — needs node-label probe)
  //   vcluster:  "v1.31.0+vcluster.0" (depends on vcluster image)
  //   eks/gke:   plain "v1.31.4-eks-..." or "v1.31.4-gke..."
  if (/\+k3s/i.test(gitVersion)) return 'k3s';
  if (/\+k0s/i.test(gitVersion)) return 'k0s';
  if (/\+vcluster/i.test(gitVersion)) return 'vcluster';
  if (gitVersion === '') return 'unknown';
  // Plain semver — could be kind, capi-managed, or vanilla. Caller may
  // refine via node labels (kind nodes have role=control-plane labels).
  return 'kubernetes';
}

interface ReadinessOptions {
  /** Path to the kubeconfig that talks to the leased cluster. */
  kubeconfig: string;
  /** Minimum number of non-control-plane nodes that must be Ready. Set
   *  to 0 to allow control-plane-only clusters (k3s standalone, vcluster
   *  with no agent pool yet). */
  minReadyNodes: number;
  /** Hard deadline for the entire wait, in ms. */
  timeoutMs: number;
  /** Optional: backend hint (informational, surfaced in log output). */
  backend?: ClusterBackend;
}

interface ReadinessResult {
  totalNodes: number;
  readyNodes: number;
  workerNodes: number;
  readyWorkerNodes: number;
}

/**
 * Block until the cluster's nodes are Ready.
 *
 * Auto-discovery rationale: every kobe-supported backend (k3s, k0s,
 * kind, vcluster, capi-provisioned) exposes worker capacity through
 * Node objects with a standard `Ready` condition. We don't need to
 * special-case each backend — listing nodes and waiting for them all
 * to be Ready handles every distro uniformly.
 *
 * Two ready-criteria layers:
 *   1. ALL visible Nodes report `Ready=True`. This catches a
 *      half-registered agent that's reachable but not yet schedulable.
 *   2. AT LEAST `minReadyNodes` of those Ready nodes must be
 *      non-control-plane (i.e., schedulable for app workloads). For
 *      a single-node k3s server-only pool, set minReadyNodes=0.
 */
export async function waitForReady(opts: ReadinessOptions): Promise<ReadinessResult> {
  const { kubeconfig, minReadyNodes, timeoutMs, backend } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastResult: ReadinessResult = { totalNodes: 0, readyNodes: 0, workerNodes: 0, readyWorkerNodes: 0 };
  let attempt = 0;

  const backendLabel = backend && backend !== 'unknown' ? ` (${backend})` : '';
  core.info(`Waiting for cluster nodes to be Ready${backendLabel}...`);

  while (Date.now() < deadline) {
    try {
      const { stdout } = await kubectl(['get', 'nodes', '-o', 'json'], kubeconfig);
      const parsed = JSON.parse(stdout) as NodeListResult;
      lastResult = summarize(parsed);

      const allReady = lastResult.totalNodes > 0 && lastResult.readyNodes === lastResult.totalNodes;
      const enoughWorkers = lastResult.readyWorkerNodes >= minReadyNodes;

      if (allReady && enoughWorkers) {
        core.info(
          `✓ Cluster ready: ${lastResult.readyNodes}/${lastResult.totalNodes} nodes Ready` +
          (minReadyNodes > 0 ? ` (${lastResult.readyWorkerNodes} non-control-plane)` : '')
        );
        return lastResult;
      }

      attempt += 1;
      if (attempt === 3 || attempt % 10 === 0) {
        // Surface progress on slow leases without spamming.
        core.info(
          `  …still waiting: ${lastResult.readyNodes}/${lastResult.totalNodes} Ready, ` +
          `${lastResult.readyWorkerNodes}/${minReadyNodes} non-control-plane required`
        );
      }
    } catch (err) {
      core.debug(`kubectl get nodes failed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(2_000);
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for cluster readiness. ` +
    `Last seen: ${lastResult.readyNodes}/${lastResult.totalNodes} Ready, ` +
    `${lastResult.readyWorkerNodes}/${minReadyNodes} non-control-plane required.`
  );
}

function summarize(nodes: NodeListResult): ReadinessResult {
  let totalNodes = 0;
  let readyNodes = 0;
  let workerNodes = 0;
  let readyWorkerNodes = 0;

  for (const node of nodes.items ?? []) {
    totalNodes += 1;
    const ready =
      node.status?.conditions?.some(
        (c) => c.type === 'Ready' && c.status === 'True'
      ) ?? false;
    if (ready) readyNodes += 1;

    const labels = node.metadata?.labels ?? {};
    const isControlPlane =
      'node-role.kubernetes.io/control-plane' in labels ||
      'node-role.kubernetes.io/master' in labels;

    if (!isControlPlane) {
      workerNodes += 1;
      if (ready) readyWorkerNodes += 1;
    }
  }

  return { totalNodes, readyNodes, workerNodes, readyWorkerNodes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
