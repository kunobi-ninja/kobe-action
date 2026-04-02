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

      - name: Run tests against the cluster
        env:
          KUBECONFIG: ${{ steps.cluster.outputs.kubeconfig-path }}
        run: |
          kubectl get nodes
          kubectl get namespaces
          # ... run your e2e tests

      # Cluster is automatically released when the job finishes
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `endpoint` | Yes | | Kobe API endpoint URL |
| `pool` | Yes | | Pool name to claim from |
| `ttl` | No | `1h` | Lease TTL (e.g. `1h`, `30m`, `2h`) |
| `audience` | No | `kobe-system` | OIDC token audience |

## Outputs

| Output | Description |
|--------|-------------|
| `kubeconfig-path` | Path to the kubeconfig file |
| `lease-id` | Lease ID (for manual management) |
| `cluster-name` | Name of the claimed cluster |

## How it works

1. Requests an OIDC token from GitHub Actions
2. Sends a lease request to the Kobe API with the JWT
3. Writes the kubeconfig to a temporary file
4. Exposes the kubeconfig path as an output
5. Automatically releases the cluster when the job finishes (even on failure)

## Requirements

- A Kobe operator running with an `AccessPolicy` configured for GitHub Actions OIDC
- `permissions: id-token: write` on the job

## AccessPolicy example

```yaml
apiVersion: kobe.kunobi.ninja/v1alpha1
kind: AccessPolicy
metadata:
  name: github-actions
  namespace: kobe-system
spec:
  auth:
    oidc:
      issuer: https://token.actions.githubusercontent.com
      audience: [kobe-system]
  identity: "repo:{repository}:ref:{ref}"
  rules:
    - pools: ["ci-*"]
      maxTtl: 1h
      maxConcurrentLeases: 5
      maxExtensions: 2
```

## License

Apache-2.0
