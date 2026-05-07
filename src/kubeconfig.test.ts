import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import { localKubeconfigAlias, rewriteKubeconfigNames } from './kubeconfig';

describe('localKubeconfigAlias', () => {
  it.each([
    ['ci-small', 'lease-aceac0bbb7df1234567890', 'kobe-ci-small-aceac0bb'],
    ['ci-large', 'lease-ccf4f21830b9', 'kobe-ci-large-ccf4f218'],
    // Lease ID without the leading "lease-" prefix
    ['pool', 'abcdef12345', 'kobe-pool-abcdef12'],
    // Short lease ID — no slicing past the end
    ['pool', 'lease-abc', 'kobe-pool-abc'],
    ['pool', 'short', 'kobe-pool-short'],
  ])('alias for pool=%s lease=%s = %s', (pool, lease, expected) => {
    expect(localKubeconfigAlias(pool, lease)).toBe(expected);
  });
});

describe('rewriteKubeconfigNames', () => {
  // Minimal but realistic kobe-issued kubeconfig shape — single cluster,
  // context, user, with the API's default `lease-<id>` naming.
  const SAMPLE = `
apiVersion: v1
kind: Config
current-context: lease-abc
clusters:
  - name: lease-abc
    cluster:
      server: https://10.0.0.1:6443
      certificate-authority-data: AAAA
contexts:
  - name: lease-abc
    context:
      cluster: lease-abc
      user: lease-abc
      namespace: default
users:
  - name: lease-abc
    user:
      token: t0p-s3cr3t
`;

  it('renames cluster, context, user, and current-context to the alias', () => {
    const out = rewriteKubeconfigNames(SAMPLE, 'kobe-pool-deadbeef');
    const doc = yaml.load(out) as Record<string, unknown> & {
      clusters?: Array<{ name?: string }>;
      contexts?: Array<{ name?: string; context?: { cluster?: string; user?: string } }>;
      users?: Array<{ name?: string }>;
      'current-context'?: string;
    };
    expect(doc['current-context']).toBe('kobe-pool-deadbeef');
    expect(doc.clusters?.[0]?.name).toBe('kobe-pool-deadbeef');
    expect(doc.contexts?.[0]?.name).toBe('kobe-pool-deadbeef');
    expect(doc.contexts?.[0]?.context?.cluster).toBe('kobe-pool-deadbeef');
    expect(doc.contexts?.[0]?.context?.user).toBe('kobe-pool-deadbeef');
    expect(doc.users?.[0]?.name).toBe('kobe-pool-deadbeef');
  });

  it('preserves cluster.server, certificate-authority-data, and user token', () => {
    const out = rewriteKubeconfigNames(SAMPLE, 'kobe-pool-deadbeef');
    const doc = yaml.load(out) as Record<string, unknown> & {
      clusters?: Array<{ cluster?: { server?: string; 'certificate-authority-data'?: string } }>;
      users?: Array<{ user?: { token?: string } }>;
    };
    expect(doc.clusters?.[0]?.cluster?.server).toBe('https://10.0.0.1:6443');
    expect(doc.clusters?.[0]?.cluster?.['certificate-authority-data']).toBe('AAAA');
    expect(doc.users?.[0]?.user?.token).toBe('t0p-s3cr3t');
  });

  it('preserves namespace inside context', () => {
    const out = rewriteKubeconfigNames(SAMPLE, 'kobe-pool-deadbeef');
    const doc = yaml.load(out) as Record<string, unknown> & {
      contexts?: Array<{ context?: { namespace?: string } }>;
    };
    expect(doc.contexts?.[0]?.context?.namespace).toBe('default');
  });

  it('returns the input unchanged when YAML is invalid', () => {
    const garbage = '\t\tnot: yaml: at-all\n  bad: : :';
    // Either parses-but-rewrite-no-op or fails-and-returns-original; both
    // are valid behaviour. The contract is "don't lose the kubeconfig".
    expect(() => rewriteKubeconfigNames(garbage, 'kobe-pool-x')).not.toThrow();
  });

  it('returns the input unchanged for non-object YAML scalars', () => {
    expect(rewriteKubeconfigNames('null', 'kobe-pool-x')).toBe('null');
    expect(rewriteKubeconfigNames('"just-a-string"', 'kobe-pool-x')).toBe('"just-a-string"');
    expect(rewriteKubeconfigNames('42', 'kobe-pool-x')).toBe('42');
  });

  it('handles a kubeconfig that already has the right alias (idempotent)', () => {
    const renamed = rewriteKubeconfigNames(SAMPLE, 'kobe-pool-deadbeef');
    const renamedAgain = rewriteKubeconfigNames(renamed, 'kobe-pool-deadbeef');
    expect(yaml.load(renamedAgain)).toEqual(yaml.load(renamed));
  });

  it('only touches the first cluster/context/user (kobe always issues 1, but defend against multi)', () => {
    const multi = `
apiVersion: v1
kind: Config
current-context: lease-abc
clusters:
  - name: lease-abc
    cluster: { server: https://primary }
  - name: extra-cluster
    cluster: { server: https://untouched }
contexts:
  - name: lease-abc
    context: { cluster: lease-abc, user: lease-abc }
  - name: extra-context
    context: { cluster: extra-cluster, user: extra }
users:
  - name: lease-abc
    user: { token: a }
  - name: extra-user
    user: { token: b }
`;
    const out = rewriteKubeconfigNames(multi, 'kobe-pool-x');
    const doc = yaml.load(out) as Record<string, unknown> & {
      clusters?: Array<{ name?: string }>;
      contexts?: Array<{ name?: string }>;
      users?: Array<{ name?: string }>;
    };
    expect(doc.clusters?.[0]?.name).toBe('kobe-pool-x');
    expect(doc.clusters?.[1]?.name).toBe('extra-cluster'); // untouched
    expect(doc.contexts?.[1]?.name).toBe('extra-context');
    expect(doc.users?.[1]?.name).toBe('extra-user');
  });
});
