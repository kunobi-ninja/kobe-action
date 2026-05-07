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
 * The union is intentionally narrow — only values `classifyGitVersion`
 * can actually return. Notably absent:
 *   * `kind` and `capi-managed` — both report plain semver `gitVersion`
 *     with no distro marker, so they collapse into `kubernetes`. A
 *     future node-label probe could distinguish them.
 *   * `vcluster` — vcluster surfaces the underlying distro's
 *     `gitVersion` (typically `+k3s1` for the standard variant), so it
 *     classifies as `k3s` here. The `+vcluster` suffix isn't a stable
 *     contract across vcluster image variants.
 *
 * `unknown` is reserved for "couldn't classify" (empty/missing
 * gitVersion). Readiness logic doesn't branch on backend — every
 * supported backend exposes Node objects with the same Ready
 * condition — so the value is informational only.
 */
export type ClusterBackend = 'k3s' | 'k0s' | 'kubernetes' | 'unknown';

/** Errors that should fail-fast — retrying won't help. */
const FATAL_EXEC_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

interface ExecError {
  code?: string;
  message?: string;
}

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

interface ReadinessOptions {
  /** Path to the kubeconfig that talks to the leased cluster. */
  kubeconfig: string;
  /** Minimum number of non-control-plane nodes that must be Ready. Set
   *  to 0 to allow control-plane-only clusters (single-node k3s/k0s
   *  servers, vcluster with no agent pool yet). */
  minReadyNodes: number;
  /** Hard deadline for the entire wait, in ms. */
  timeoutMs: number;
  /** Optional: backend hint (informational, surfaced in log output). */
  backend?: ClusterBackend;
}

interface ReadinessResult {
  // Invariants guaranteed by `summarize`:
  //   readyNodes ≤ totalNodes
  //   workerNodes ≤ totalNodes
  //   readyWorkerNodes ≤ workerNodes
  //   readyWorkerNodes ≤ readyNodes
  totalNodes: number;
  readyNodes: number;
  workerNodes: number;
  readyWorkerNodes: number;
}

async function kubectl(
  args: string[],
  kubeconfig: string
): Promise<{ stdout: string; stderr: string }> {
  // `--request-timeout=10s` caps any single call so a stalled API server
  // doesn't hang the action's poll loop on one iteration. Belt-and-
  // suspenders: kubeconfig flag + KUBECONFIG env both pin the target
  // cluster (the flag wins; env is a guard against caller-injected env).
  return runFile(
    'kubectl',
    ['--kubeconfig', kubeconfig, '--request-timeout=10s', ...args],
    {
      encoding: 'utf-8',
      env: { ...process.env, KUBECONFIG: kubeconfig },
    }
  );
}

function isFatalExecError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && FATAL_EXEC_ERROR_CODES.has((err as ExecError).code ?? '');
}

function isVersionResult(value: unknown): value is VersionResult {
  if (typeof value !== 'object' || value === null) return false;
  const sv = (value as VersionResult).serverVersion;
  if (sv === undefined) return true;
  if (typeof sv !== 'object' || sv === null) return false;
  const gv = sv.gitVersion;
  return gv === undefined || typeof gv === 'string';
}

function isNodeListResult(value: unknown): value is NodeListResult {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as NodeListResult).items);
}

/**
 * Detect the cluster's backend by inspecting the API server's
 * `gitVersion` string.
 *
 * Returns `unknown` on any failure — the `cluster-backend` output is
 * documented as informational, so a probe failure shouldn't fail the
 * action. Failures are surfaced as warnings (not debug-only) so users
 * see something at default log level rather than a silent `unknown`.
 */
export async function detectBackend(kubeconfig: string): Promise<ClusterBackend> {
  try {
    const { stdout } = await kubectl(['version', '-o', 'json'], kubeconfig);
    const parsed: unknown = JSON.parse(stdout);
    if (!isVersionResult(parsed)) {
      core.warning('Backend detection: unexpected kubectl version JSON shape');
      return 'unknown';
    }
    const gitVersion = parsed.serverVersion?.gitVersion ?? '';
    return classifyGitVersion(gitVersion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Backend detection failed: ${msg}`);
    return 'unknown';
  }
}

export function classifyGitVersion(gitVersion: string): ClusterBackend {
  // Real-world `serverVersion.gitVersion` examples:
  //   k3s:        "v1.31.4+k3s1"
  //   k0s:        "v1.31.4+k0s"
  //   kind:       "v1.31.0"           (plain semver; no marker)
  //   eks/gke:    "v1.31.4-eks-..." / "v1.31.4-gke..."  (vendor suffix)
  //   vcluster:   inherits underlying distro, usually "+k3s1"
  //
  // Order matters: check `+k3s` before `+k0s` (otherwise harmless, but
  // mirrors how distros version themselves alphabetically in the wild).
  if (/\+k3s/i.test(gitVersion)) return 'k3s';
  if (/\+k0s/i.test(gitVersion)) return 'k0s';
  if (gitVersion === '') return 'unknown';
  // Plain semver / vendor suffix — covers vanilla, kind, capi-managed,
  // EKS, GKE, AKS, vcluster's k3s-backed variant, etc. All work
  // identically for readiness; the bucket is intentionally broad.
  return 'kubernetes';
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
 *
 * Error handling:
 *   - Fatal `execFile` errors (ENOENT/EACCES/EPERM — kubectl missing,
 *     kubeconfig unreadable) throw immediately; retrying won't help and
 *     a 2-minute hang on these is worse than a fast, clear failure.
 *   - Transient errors (network blip, API server still starting) are
 *     surfaced as warnings after the first occurrence, then re-tried.
 *   - The timeout exception includes the last seen error so users don't
 *     need ACTIONS_STEP_DEBUG=true to see why polls failed.
 */
export async function waitForReady(opts: ReadinessOptions): Promise<ReadinessResult> {
  const { kubeconfig, minReadyNodes, timeoutMs, backend } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastResult: ReadinessResult = { totalNodes: 0, readyNodes: 0, workerNodes: 0, readyWorkerNodes: 0 };
  let lastError = '';
  let attempt = 0;
  let warnedTransient = false;

  const backendLabel = backend && backend !== 'unknown' ? ` (${backend})` : '';
  core.info(`Waiting for cluster nodes to be Ready${backendLabel}...`);

  while (Date.now() < deadline) {
    try {
      const { stdout } = await kubectl(['get', 'nodes', '-o', 'json'], kubeconfig);
      const parsed: unknown = JSON.parse(stdout);
      if (!isNodeListResult(parsed)) {
        lastError = 'unexpected kubectl get nodes JSON shape';
        if (!warnedTransient) {
          core.warning(`Readiness probe: ${lastError}`);
          warnedTransient = true;
        }
      } else {
        lastResult = summarize(parsed);
        lastError = '';

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
      }
    } catch (err) {
      if (isFatalExecError(err)) {
        const code = (err as ExecError).code;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Readiness probe failed fatally (${code}): ${msg}. ` +
          `Hint: ensure \`kubectl\` is on PATH and the kubeconfig at "${kubeconfig}" is readable.`
        );
      }
      lastError = err instanceof Error ? err.message : String(err);
      if (!warnedTransient) {
        core.warning(`Readiness probe (transient): ${lastError}`);
        warnedTransient = true;
      } else {
        core.debug(`Readiness probe transient error: ${lastError}`);
      }
    }

    await sleep(2_000);
  }

  const errSuffix = lastError ? `; last error: ${lastError}` : '';
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for cluster readiness. ` +
    `Last seen: ${lastResult.readyNodes}/${lastResult.totalNodes} Ready, ` +
    `${lastResult.readyWorkerNodes}/${minReadyNodes} non-control-plane required` +
    errSuffix +
    `.`
  );
}

/**
 * Walk a NodeList and count totals, Ready nodes, and (separately)
 * non-control-plane worker capacity. Exported for unit testing.
 */
export function summarize(nodes: NodeListResult): ReadinessResult {
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
    // Both the modern `control-plane` label and the legacy `master` label
    // (still present on older k3s/k8s installs) mark a node as control
    // plane — exclude both from worker counts.
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
