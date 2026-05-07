import * as yaml from 'js-yaml';

/**
 * Friendly local alias for a leased cluster's kubeconfig entries.
 *
 * Mirrors the kobe CLI's `local_kubeconfig_alias` (kobe's
 * `src/cli/commands/lease_create.rs`) so that the action and the CLI
 * produce kubeconfigs with identical context naming. Consumers (test
 * suites, downstream tooling) can rely on a stable `kobe-<pool>-<id>`
 * prefix regardless of which interface created the lease.
 *
 * Format: `kobe-{pool}-{first 8 chars of lease id, sans "lease-" prefix}`.
 *
 * Examples:
 *   pool=ci-small, lease=lease-aceac0bbb7df... → kobe-ci-small-aceac0bb
 *   pool=ci-large, lease=ccf4f21830b9          → kobe-ci-large-ccf4f218
 */
export function localKubeconfigAlias(pool: string, leaseId: string): string {
  const stripped = leaseId.startsWith('lease-') ? leaseId.slice('lease-'.length) : leaseId;
  // CLI fallback: if the stripped id is shorter than 8 chars, use it whole
  // (matches the `.get(..8).unwrap_or_else(...)` behaviour in Rust).
  const short = stripped.length >= 8 ? stripped.slice(0, 8) : stripped;
  return `kobe-${pool}-${short}`;
}

interface KubeconfigDoc {
  clusters?: Array<{ name?: string; cluster?: unknown }>;
  contexts?: Array<{
    name?: string;
    context?: { cluster?: string; user?: string; namespace?: string };
  }>;
  users?: Array<{ name?: string; user?: unknown }>;
  'current-context'?: string;
  [key: string]: unknown;
}

/**
 * Rewrite a leased kubeconfig so its first cluster, context, and user
 * are all renamed to `alias`, and `current-context` points at it.
 *
 * Mirrors `rewrite_local_kubeconfig_names` from kobe's CLI
 * (`src/cli/commands/lease_create.rs`). Only the first entry of each
 * sequence is touched — kobe-issued kubeconfigs are single-cluster by
 * construction.
 *
 * If the input isn't valid YAML, returns it unchanged. The CLI takes
 * the same approach (`unwrap_or_else(|_| kubeconfig.to_string())`):
 * better to ship a usable raw kubeconfig than to fail the lease over
 * a cosmetic naming pass.
 */
export function rewriteKubeconfigNames(kubeconfig: string, alias: string): string {
  let doc: KubeconfigDoc;
  try {
    const parsed = yaml.load(kubeconfig);
    if (typeof parsed !== 'object' || parsed === null) {
      return kubeconfig;
    }
    doc = parsed as KubeconfigDoc;
  } catch {
    return kubeconfig;
  }

  const cluster = doc.clusters?.[0];
  if (cluster) cluster.name = alias;

  const context = doc.contexts?.[0];
  if (context) {
    context.name = alias;
    if (context.context) {
      if ('cluster' in context.context) context.context.cluster = alias;
      if ('user' in context.context) context.context.user = alias;
    }
  }

  const user = doc.users?.[0];
  if (user) user.name = alias;

  doc['current-context'] = alias;

  try {
    return yaml.dump(doc, { lineWidth: -1, noRefs: true });
  } catch {
    return kubeconfig;
  }
}
