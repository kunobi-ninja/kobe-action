# Kobe Cluster Action

Claim a Kubernetes cluster from a [Kobe](https://github.com/kunobi-ninja/kobe) pool for CI/CD. The cluster is **automatically released** when the job finishes -- no cleanup step needed.

## Usage

```yaml
permissions:
  id-token: write   # Required for OIDC authentication

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: kunobi-ninja/kobe-action@v2
        id: cluster
        with:
          endpoint: https://kobe.example.com
          pool: ci-small

      - run: kubectl --kubeconfig=${{ steps.cluster.outputs.kubeconfig-path }} get nodes

      # No release step needed -- auto-cleanup via post hook!
```

## How it works

1. Acquires a GitHub OIDC token for authentication
2. Creates a lease via the Kobe API (`POST /v1/leases`)
3. If the pool is exhausted (HTTP 503), retries with exponential backoff
4. If the lease is queued (Pending phase), polls until the cluster is Bound
5. Writes the kubeconfig to a temp file and exposes the path as an output
6. Probes the cluster for its backend (k3s / k0s / vcluster / vanilla) via `kubectl version` — surfaced as the `cluster-backend` output
7. (Optional, when `wait-for-ready: true`) blocks until cluster Nodes report Ready, so tests don't race the agent-registration window
8. On job exit (success, failure, or cancellation), the `post` hook automatically releases the lease

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `endpoint` | Yes | | Kobe API endpoint URL |
| `pool` | Yes | | Pool name to claim from (e.g. `ci-small`) |
| `ttl` | No | `1h` | Lease TTL (e.g. `1h`, `30m`) |
| `audience` | No | `kobe-system` | OIDC token audience |
| `timeout` | No | `5m` | Max time to wait for the lease to become **Bound** (API server reachable) |
| `wait-for-ready` | No | `false` | After Bound, also wait for cluster Nodes to be Ready. Default off for backward compatibility — set `true` if your tests query the cluster immediately. |
| `min-ready-nodes` | No | `0` | Minimum non-control-plane nodes that must be Ready (only when `wait-for-ready=true`). Default `0` accepts single-node k3s/k0s server pools (the most common CI shape). Set `1` or higher for multi-node setups that need a worker. |
| `ready-timeout` | No | `2m` | Max time to wait for cluster readiness after Bound. Independent from `timeout`. |

## Outputs

| Output | Description |
|--------|-------------|
| `kubeconfig-path` | Path to the kubeconfig file |
| `lease-id` | Lease ID |
| `cluster-name` | Name of the claimed cluster |
| `cluster-backend` | Auto-detected backend: `k3s` \| `k0s` \| `kubernetes` \| `unknown`. The `kubernetes` value is a generic bucket — it covers vanilla, kind, capi-managed, EKS/GKE/AKS, and vcluster (which reports the underlying distro's `gitVersion`, typically k3s). |

## Waiting for cluster readiness

A `Bound` lease means the API server is reachable, but worker Pods can take 10–60s longer to register as Nodes (especially on freshly-provisioned k3s/k0s pools). Tests that hit `kubectl get nodes` in their `beforeAll` can race that window and skip themselves.

Opt in with one input:

```yaml
- uses: kunobi-ninja/kobe-action@v2
  with:
    endpoint: https://kobe.example.com
    pool: ci-k3s-small
    wait-for-ready: true
    # Defaults work for single-node pools (min-ready-nodes=0).
    # For multi-node setups, require at least one worker:
    # min-ready-nodes: 1
```

Auto-discovery: every supported backend (k3s, k0s, kind, vcluster, capi-managed) reports worker capacity through Node objects with a standard `Ready` condition. The action lists nodes and waits until they're all Ready — no per-backend configuration needed.

Strict input parsing: `wait-for-ready`, `min-ready-nodes`, and `ready-timeout` reject unrecognized values (e.g. `wait-for-ready: ture`, `min-ready-nodes: abc`, `ready-timeout: 30sec`) at job startup with a clear error. Empty values fall through to the documented defaults.

## Migration from v1

v1 used a composite action with separate claim/release steps. v2 is a Node.js action with a `post` hook, so you no longer need a release step:

```diff
- - uses: kunobi-ninja/kobe-action@v1
+ - uses: kunobi-ninja/kobe-action@v2
    id: cluster
    with:
      endpoint: https://kobe.example.com
      pool: ci-small

  - run: kubectl --kubeconfig=${{ steps.cluster.outputs.kubeconfig-path }} get nodes

- - uses: kunobi-ninja/kobe-action/release@v1
-   if: always()
-   with:
-     endpoint: https://kobe.example.com
-     lease-id: ${{ steps.cluster.outputs.lease-id }}
-     token: ${{ steps.cluster.outputs.token }}
+ # Release is automatic -- nothing to add!
```

## Requirements

- Kobe operator with an AccessPolicy for GitHub Actions OIDC
- `permissions: id-token: write` on the job

## License

Apache-2.0
