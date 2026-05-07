import { describe, expect, it } from 'vitest';
import { classifyGitVersion, summarize } from './readiness';

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
