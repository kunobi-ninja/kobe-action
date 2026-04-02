# Kobe Action

GitHub Action for claiming Kubernetes clusters from [Kobe](https://github.com/kunobi-ninja/kobe) pools.

## Usage

```yaml
jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # Required for OIDC

    steps:
      - uses: actions/checkout@v4

      - uses: kunobi-ninja/kobe-action@v1
        id: cluster
        with:
          endpoint: https://kobe.example.com
          pool: ci-small
          ttl: 1h

      - name: Run tests
        env:
          KUBECONFIG: ${{ steps.cluster.outputs.kubeconfig-path }}
        run: |
          kubectl get nodes
          # ... your e2e tests

      - name: Release cluster
        if: always()
        uses: kunobi-ninja/kobe-action/release@v1
        with:
          endpoint: https://kobe.example.com
          lease-id: ${{ steps.cluster.outputs.lease-id }}
          token: ${{ steps.cluster.outputs.token }}
```

## Actions

### `kunobi-ninja/kobe-action@v1` — Claim

Claims a cluster from a pool.

**Inputs:**

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `endpoint` | Yes | | Kobe API endpoint URL |
| `pool` | Yes | | Pool name to claim from |
| `ttl` | No | `1h` | Lease TTL (e.g. `1h`, `30m`) |
| `audience` | No | `kobe-system` | OIDC token audience |

**Outputs:**

| Output | Description |
|--------|-------------|
| `kubeconfig-path` | Path to the kubeconfig file |
| `lease-id` | Lease ID (pass to release action) |
| `cluster-name` | Name of the claimed cluster |
| `token` | Auth token (pass to release action) |

### `kunobi-ninja/kobe-action/release@v1` — Release

Releases a previously claimed cluster. Use `if: always()` to ensure release even on failure.

**Inputs:**

| Input | Required | Description |
|-------|----------|-------------|
| `endpoint` | Yes | Kobe API endpoint URL |
| `lease-id` | Yes | Lease ID from claim output |
| `token` | Yes | Token from claim output |

## How it works

1. Requests an OIDC token from GitHub Actions
2. Claims a cluster via `POST /v1/leases`
3. Writes kubeconfig to a temporary file
4. Your steps use the cluster via `KUBECONFIG` env var
5. Release action calls `DELETE /v1/leases/{id}` (runs even on failure with `if: always()`)

## Requirements

- Kobe operator with an AccessPolicy for GitHub Actions OIDC
- `permissions: id-token: write` on the job

## License

Apache-2.0
