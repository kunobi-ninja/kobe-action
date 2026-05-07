import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import * as core from '@actions/core';

// `readiness.ts` does `promisify(execFile)` at module load. Node's stock
// `execFile` carries a `[util.promisify.custom]` symbol that returns
// `{ stdout, stderr }` directly — naively replacing `execFile` with a
// plain `vi.fn()` loses that contract and `runFile(...)` breaks.
//
// Strategy: mock `node:child_process` with an `execFile` whose
// `[util.promisify.custom]` is a controllable async function. Tests
// configure the resolver/rejector via the exported `__setExecFile`
// helper. This mirrors real Node behaviour without us having to
// hand-roll the (cmd, args, opts, cb) callback shape.

let execFileImpl: (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>;
const execFileCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];

vi.mock('node:child_process', () => {
  const mock: unknown = function execFile() {
    throw new Error('mocked execFile called via callback shape — readiness.ts uses promisify, fix the test');
  };
  (mock as { [k: symbol]: unknown })[promisify.custom] = (
    cmd: string,
    args: string[],
    opts: unknown,
  ) => {
    execFileCalls.push({ cmd, args, opts });
    return execFileImpl(cmd, args, opts);
  };
  return { execFile: mock };
});

import { detectBackend, waitForReady, classifyGitVersion, summarize } from './readiness';

beforeEach(() => {
  execFileCalls.length = 0;
  execFileImpl = () => Promise.reject(new Error('execFileImpl not configured for this test'));
  vi.spyOn(core, 'warning').mockImplementation(() => {});
  vi.spyOn(core, 'info').mockImplementation(() => {});
  vi.spyOn(core, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Helper: build an Error with a `code` property (mirrors what Node
// surfaces from execFile failures — ENOENT, EACCES, ETIMEDOUT, etc.).
function execError(code: string, message = `mock ${code}`): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('classifyGitVersion', () => {
  it.each([
    ['v1.31.4+k3s1', 'k3s'],
    ['v1.30.2+k3s2', 'k3s'],
    ['v1.31.4+K3S1', 'k3s'], // case-insensitive
    ['v1.31.4+k0s', 'k0s'],
    ['v1.31.4+k0s.0', 'k0s'],
  ])('classifies %j as %s', (input, expected) => {
    expect(classifyGitVersion(input)).toBe(expected);
  });

  it.each([
    'v1.31.0', // plain semver — kind, capi, vanilla
    'v1.31.4-eks-a1b2c3d', // EKS
    'v1.31.0-gke.1234', // GKE
    'v1.31.0+vcluster.0', // vcluster's stale-marker variant
    'v1.31.4-rc.1',
  ])('classifies %j as kubernetes (generic bucket)', (input) => {
    expect(classifyGitVersion(input)).toBe('kubernetes');
  });

  it('returns unknown for empty input', () => {
    expect(classifyGitVersion('')).toBe('unknown');
  });
});

describe('summarize', () => {
  const ready = (name: string, role?: 'control-plane' | 'master') => ({
    metadata: {
      name,
      labels: role
        ? { [`node-role.kubernetes.io/${role}`]: 'true' }
        : {},
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  });
  const notReady = (name: string, role?: 'control-plane' | 'master') => ({
    metadata: {
      name,
      labels: role
        ? { [`node-role.kubernetes.io/${role}`]: 'true' }
        : {},
    },
    status: { conditions: [{ type: 'Ready', status: 'False' }] },
  });

  it('counts an empty cluster as 0/0 across the board', () => {
    expect(summarize({ items: [] })).toEqual({
      totalNodes: 0,
      readyNodes: 0,
      workerNodes: 0,
      readyWorkerNodes: 0,
    });
  });

  it('counts a single-node k3s server pool with 0 workers', () => {
    // Default `min-ready-nodes: 0` lets this pool pass; the test pins
    // the contract: control-plane node doesn't contribute to worker counts.
    const result = summarize({ items: [ready('k3s-server', 'control-plane')] });
    expect(result).toEqual({
      totalNodes: 1,
      readyNodes: 1,
      workerNodes: 0,
      readyWorkerNodes: 0,
    });
  });

  it('counts a server + agent setup as 1 worker', () => {
    const result = summarize({
      items: [ready('server', 'control-plane'), ready('agent')],
    });
    expect(result).toEqual({
      totalNodes: 2,
      readyNodes: 2,
      workerNodes: 1,
      readyWorkerNodes: 1,
    });
  });

  it('treats the legacy `master` label as control-plane', () => {
    const result = summarize({ items: [ready('legacy-master', 'master')] });
    expect(result.workerNodes).toBe(0);
  });

  it('counts a half-ready cluster correctly', () => {
    const result = summarize({
      items: [ready('server', 'control-plane'), notReady('agent')],
    });
    expect(result).toEqual({
      totalNodes: 2,
      readyNodes: 1,
      workerNodes: 1,
      readyWorkerNodes: 0,
    });
  });

  it('does not count Ready=Unknown or any non-True status as Ready', () => {
    const node = (status: string) => ({
      metadata: { name: 'n', labels: {} },
      status: { conditions: [{ type: 'Ready', status }] },
    });
    expect(
      summarize({ items: [node('Unknown'), node('false'), node('true')] })
        .readyNodes
    ).toBe(0);
  });

  it('survives nodes missing optional fields without throwing', () => {
    const result = summarize({
      items: [
        // No metadata.labels, no status.conditions
        { metadata: { name: 'incomplete' } } as never,
        { status: {} } as never,
        {} as never,
      ],
    });
    expect(result.totalNodes).toBe(3);
    expect(result.readyNodes).toBe(0);
    expect(result.workerNodes).toBe(3); // no labels = treated as worker
  });

  it('honours the invariant readyWorkerNodes <= readyNodes <= totalNodes', () => {
    const result = summarize({
      items: [
        ready('cp', 'control-plane'),
        ready('w1'),
        notReady('w2'),
      ],
    });
    expect(result.readyWorkerNodes).toBeLessThanOrEqual(result.readyNodes);
    expect(result.readyNodes).toBeLessThanOrEqual(result.totalNodes);
    expect(result.workerNodes).toBeLessThanOrEqual(result.totalNodes);
  });
});

describe('detectBackend', () => {
  const KUBECONFIG = '/tmp/kubeconfig.yaml';

  function stdout(payload: unknown): string {
    return JSON.stringify(payload);
  }

  it('classifies k3s from gitVersion suffix', async () => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: { gitVersion: 'v1.31.4+k3s1' } }),
      stderr: '',
    });
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('k3s');
  });

  it('classifies k0s from gitVersion suffix', async () => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: { gitVersion: 'v1.31.4+k0s' } }),
      stderr: '',
    });
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('k0s');
  });

  it.each([
    ['v1.31.0'],
    ['v1.31.4-eks-a1b2c3d'],
    ['v1.31.0-gke.1234'],
  ])('classifies %s as kubernetes', async (gitVersion) => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: { gitVersion } }),
      stderr: '',
    });
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('kubernetes');
  });

  it('returns unknown when serverVersion is missing', async () => {
    execFileImpl = async () => ({ stdout: stdout({}), stderr: '' });
    // Empty gitVersion => classifyGitVersion returns 'unknown'.
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('unknown');
  });

  it('returns unknown when gitVersion is missing on serverVersion', async () => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: {} }),
      stderr: '',
    });
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('unknown');
  });

  it('warns and returns unknown on non-JSON kubectl output', async () => {
    execFileImpl = async () => ({ stdout: 'not json at all', stderr: '' });
    const warn = vi.spyOn(core, 'warning');
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Backend detection failed'),
    );
  });

  it('warns and returns unknown when JSON shape is wrong (serverVersion is a string)', async () => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: 'string-not-object' }),
      stderr: '',
    });
    const warn = vi.spyOn(core, 'warning');
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      'Backend detection: unexpected kubectl version JSON shape',
    );
  });

  it('returns unknown (does not throw) when kubectl is missing (ENOENT)', async () => {
    execFileImpl = async () => {
      throw execError('ENOENT', 'kubectl not found');
    };
    const warn = vi.spyOn(core, 'warning');
    await expect(detectBackend(KUBECONFIG)).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Backend detection failed'),
    );
  });

  it('invokes kubectl with kubeconfig + request-timeout + version -o json', async () => {
    execFileImpl = async () => ({
      stdout: stdout({ serverVersion: { gitVersion: 'v1.31.0' } }),
      stderr: '',
    });
    await detectBackend(KUBECONFIG);
    expect(execFileCalls).toHaveLength(1);
    const call = execFileCalls[0];
    expect(call.cmd).toBe('kubectl');
    expect(call.args).toEqual([
      '--kubeconfig',
      KUBECONFIG,
      '--request-timeout=10s',
      'version',
      '-o',
      'json',
    ]);
  });
});

describe('waitForReady', () => {
  const KUBECONFIG = '/tmp/kubeconfig.yaml';

  // Build a kubectl-get-nodes payload from a list of (ready, isCP) pairs.
  function nodesStdout(
    nodes: Array<{ name: string; ready: boolean; controlPlane?: boolean }>,
  ): string {
    return JSON.stringify({
      items: nodes.map((n) => ({
        metadata: {
          name: n.name,
          labels: n.controlPlane
            ? { 'node-role.kubernetes.io/control-plane': 'true' }
            : {},
        },
        status: {
          conditions: [{ type: 'Ready', status: n.ready ? 'True' : 'False' }],
        },
      })),
    });
  }

  // Sleep-collapsing strategy: stub global setTimeout to fire callbacks
  // synchronously. The 2s `sleep(2_000)` between polls collapses to a
  // microtask, which lets us simulate many iterations without actually
  // waiting. (We tried `vi.useFakeTimers()` first, but advancing them
  // in async loops gets fiddly when the promise chain is long.)
  let restoreSetTimeout: (() => void) | undefined;
  function collapseSleeps() {
    const real = globalThis.setTimeout;
    const stub: typeof globalThis.setTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    globalThis.setTimeout = stub;
    restoreSetTimeout = () => {
      globalThis.setTimeout = real;
    };
  }

  afterEach(() => {
    if (restoreSetTimeout) {
      restoreSetTimeout();
      restoreSetTimeout = undefined;
    }
  });

  it('returns immediately when all nodes are Ready and minReadyNodes=0', async () => {
    execFileImpl = async () => ({
      stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
      stderr: '',
    });
    const result = await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 0,
      timeoutMs: 60_000,
    });
    expect(result).toEqual({
      totalNodes: 1,
      readyNodes: 1,
      workerNodes: 0,
      readyWorkerNodes: 0,
    });
  });

  it('returns immediately for server+agent when minReadyNodes=1', async () => {
    execFileImpl = async () => ({
      stdout: nodesStdout([
        { name: 'cp', ready: true, controlPlane: true },
        { name: 'w1', ready: true },
      ]),
      stderr: '',
    });
    const result = await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 1,
      timeoutMs: 60_000,
    });
    expect(result.workerNodes).toBe(1);
    expect(result.readyWorkerNodes).toBe(1);
  });

  it('logs the backend hint in the initial info message when provided', async () => {
    const info = vi.spyOn(core, 'info');
    execFileImpl = async () => ({
      stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
      stderr: '',
    });
    await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 0,
      timeoutMs: 60_000,
      backend: 'k3s',
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('(k3s)'),
    );
  });

  it('omits the backend hint when backend is unknown', async () => {
    const info = vi.spyOn(core, 'info');
    execFileImpl = async () => ({
      stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
      stderr: '',
    });
    await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 0,
      timeoutMs: 60_000,
      backend: 'unknown',
    });
    // Initial "Waiting for cluster nodes to be Ready..." has no
    // parenthetical when the backend is unknown.
    expect(info).toHaveBeenCalledWith('Waiting for cluster nodes to be Ready...');
  });

  it('times out when minReadyNodes is unreachable (server-only, need 1)', async () => {
    collapseSleeps();
    execFileImpl = async () => ({
      stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
      stderr: '',
    });
    await expect(
      waitForReady({
        kubeconfig: KUBECONFIG,
        minReadyNodes: 1,
        timeoutMs: 50, // collapsed sleeps: only the deadline check matters
      }),
    ).rejects.toThrow(/Timed out after .* waiting for cluster readiness/);
  });

  it('polls until a not-ready agent becomes ready', async () => {
    collapseSleeps();
    let call = 0;
    execFileImpl = async () => {
      call += 1;
      const ready = call >= 2; // first call: not ready, then ready
      return {
        stdout: nodesStdout([
          { name: 'cp', ready: true, controlPlane: true },
          { name: 'w1', ready },
        ]),
        stderr: '',
      };
    };
    const result = await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 1,
      timeoutMs: 60_000,
    });
    expect(call).toBeGreaterThanOrEqual(2);
    expect(result.readyWorkerNodes).toBe(1);
  });

  it.each([['ENOENT'], ['EACCES']])(
    'fails fast on fatal exec error %s without retrying',
    async (code) => {
      let calls = 0;
      execFileImpl = async () => {
        calls += 1;
        throw execError(code);
      };
      await expect(
        waitForReady({
          kubeconfig: KUBECONFIG,
          minReadyNodes: 0,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(
        new RegExp(`Readiness probe failed fatally \\(${code}\\)`),
      );
      // Single call — fatal errors should not retry.
      expect(calls).toBe(1);
    },
  );

  it('fatal-error message includes hint about kubectl on PATH', async () => {
    execFileImpl = async () => {
      throw execError('ENOENT', 'no kubectl');
    };
    await expect(
      waitForReady({
        kubeconfig: KUBECONFIG,
        minReadyNodes: 0,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/kubectl.*on PATH/);
  });

  it('retries on transient errors and eventually returns success', async () => {
    collapseSleeps();
    let call = 0;
    execFileImpl = async () => {
      call += 1;
      if (call < 3) throw execError('ETIMEDOUT', 'transient');
      return {
        stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
        stderr: '',
      };
    };
    const warn = vi.spyOn(core, 'warning');
    const result = await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 0,
      timeoutMs: 60_000,
    });
    expect(result.readyNodes).toBe(1);
    // Transient warning fires once (first occurrence), subsequent goes to debug.
    const transientWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('Readiness probe (transient)'),
    );
    expect(transientWarnings.length).toBe(1);
  });

  it('on persistent transient errors, eventually times out and surfaces last error', async () => {
    collapseSleeps();
    execFileImpl = async () => {
      throw execError('ETIMEDOUT', 'still flaking');
    };
    await expect(
      waitForReady({
        kubeconfig: KUBECONFIG,
        minReadyNodes: 0,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/Timed out.*last error: still flaking/s);
  });

  it('warns on schema drift (items not array) and keeps polling', async () => {
    collapseSleeps();
    let call = 0;
    execFileImpl = async () => {
      call += 1;
      if (call === 1) {
        return { stdout: JSON.stringify({ items: 'wrong-shape' }), stderr: '' };
      }
      return {
        stdout: nodesStdout([{ name: 'cp', ready: true, controlPlane: true }]),
        stderr: '',
      };
    };
    const warn = vi.spyOn(core, 'warning');
    const result = await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 0,
      timeoutMs: 60_000,
    });
    expect(result.readyNodes).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unexpected kubectl get nodes JSON shape'),
    );
  });

  it('logs progress on slow leases (3rd attempt and every 10th)', async () => {
    collapseSleeps();
    const info = vi.spyOn(core, 'info');
    let call = 0;
    execFileImpl = async () => {
      call += 1;
      const ready = call >= 5; // succeed on 5th call so we hit the 3rd-attempt log
      return {
        stdout: nodesStdout([
          { name: 'cp', ready: true, controlPlane: true },
          { name: 'w1', ready },
        ]),
        stderr: '',
      };
    };
    await waitForReady({
      kubeconfig: KUBECONFIG,
      minReadyNodes: 1,
      timeoutMs: 60_000,
    });
    const stillWaiting = info.mock.calls.filter((c) =>
      String(c[0]).includes('still waiting'),
    );
    expect(stillWaiting.length).toBeGreaterThanOrEqual(1);
  });
});
