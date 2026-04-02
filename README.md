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
6. On job exit (success, failure, or cancellation), the `post` hook automatically releases the lease

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `endpoint` | Yes | | Kobe API endpoint URL |
| `pool` | Yes | | Pool name to claim from (e.g. `ci-small`) |
| `ttl` | No | `1h` | Lease TTL (e.g. `1h`, `30m`) |
| `audience` | No | `kobe-system` | OIDC token audience |
| `timeout` | No | `5m` | Max time to wait for cluster to be ready |

## Outputs

| Output | Description |
|--------|-------------|
| `kubeconfig-path` | Path to the kubeconfig file |
| `lease-id` | Lease ID |
| `cluster-name` | Name of the claimed cluster |

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
