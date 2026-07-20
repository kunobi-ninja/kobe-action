import * as core from '@actions/core';
import { HttpClient } from '@actions/http-client';

export interface LeaseResponse {
  id: string;
  clusterName?: string;
  cluster_name?: string;
  kubeconfig?: string;
  phase?: string;
  expiresAt?: string;
}

export interface KobeError {
  error?: string;
  message?: string;
  /** Operator diagnosis: pool phase, consecutive failures, last failure reason. */
  detail?: string;
  /** Machine-readable rejection class, e.g. `pool_exhausted`, `capacity_blocked`. */
  reason?: string;
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff
/** Ceiling on a server-suggested Retry-After so a pool in a long backoff
 * window can't stall CI for minutes per attempt. */
const MAX_RETRY_DELAY_MS = 30_000;

export class KobeClient {
  private http: HttpClient;
  private endpoint: string;
  private token: string;

  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.token = token;
    this.http = new HttpClient('kobe-action', [], {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async createLease(pool: string, ttl: string): Promise<LeaseResponse> {
    const url = `${this.endpoint}/v1/leases`;
    // Wire field is `profile`, not `pool` — that's the historical name kobe
    // uses internally for ClusterPool resources, and what the API's
    // `CreateLeaseRequest` deserializes (matches the kobe CLI's body shape).
    // The action's user-facing input stays `pool` to match the CLI UX
    // (`kobe lease <pool>`).
    const body = JSON.stringify({ profile: pool, ttl });

    let lastDetail: string | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const response = await this.http.post(url, body);
      const responseBody = await response.readBody();
      const statusCode = response.message.statusCode ?? 0;

      if (statusCode >= 200 && statusCode < 300) {
        return JSON.parse(responseBody) as LeaseResponse;
      }

      if (statusCode === 503 && attempt < RETRY_DELAYS.length) {
        const err = tryParseKobeError(responseBody);
        const reason = err?.reason || 'pool unavailable';
        // Surface the operator's diagnosis (pool phase, consecutive
        // failures, last failure reason) once per distinct message —
        // this is what tells a CI reader *why* the pool can't serve,
        // not just that it returned 503.
        if (err?.detail && err.detail !== lastDetail) {
          lastDetail = err.detail;
          core.warning(`Pool cannot satisfy the lease (${reason}): ${err.detail}`);
        }
        const retryAfterMs = parseRetryAfterMs(response.message.headers['retry-after']);
        const delay = Math.min(
          Math.max(RETRY_DELAYS[attempt], retryAfterMs ?? 0),
          MAX_RETRY_DELAY_MS
        );
        core.info(`Pool unavailable (503, ${reason}), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${RETRY_DELAYS.length})`);
        await sleep(delay);
        continue;
      }

      const error = tryParseError(responseBody);
      throw new Error(
        `Failed to create lease (HTTP ${statusCode}): ${error}`
      );
    }

    throw new Error('Failed to create lease after all retries');
  }

  async getLease(leaseId: string): Promise<LeaseResponse> {
    const url = `${this.endpoint}/v1/leases/${leaseId}`;
    const response = await this.http.get(url);
    const body = await response.readBody();
    const statusCode = response.message.statusCode ?? 0;

    if (statusCode >= 200 && statusCode < 300) {
      return JSON.parse(body) as LeaseResponse;
    }

    throw new Error(`Failed to get lease (HTTP ${statusCode}): ${tryParseError(body)}`);
  }

  async waitForBind(leaseId: string, timeoutMs: number): Promise<LeaseResponse> {
    const deadline = Date.now() + timeoutMs;
    let pollInterval = 2000;

    while (Date.now() < deadline) {
      const lease = await this.getLease(leaseId);
      const phase = lease.phase?.toLowerCase();

      if (phase === 'bound') {
        return lease;
      }

      if (phase === 'expired' || phase === 'released' || phase === 'recycling') {
        throw new Error(`Lease entered unexpected phase: ${lease.phase}`);
      }

      core.info(`Lease ${leaseId} is ${lease.phase}, waiting...`);
      await sleep(Math.min(pollInterval, deadline - Date.now()));
      pollInterval = Math.min(pollInterval * 1.5, 10000);
    }

    throw new Error(`Timed out waiting for lease ${leaseId} to bind after ${timeoutMs / 1000}s`);
  }

  async releaseLease(leaseId: string): Promise<void> {
    const url = `${this.endpoint}/v1/leases/${leaseId}`;

    try {
      const response = await this.http.del(url);
      const statusCode = response.message.statusCode ?? 0;

      if (statusCode >= 200 && statusCode < 300) {
        core.info(`Released lease ${leaseId}`);
      } else if (statusCode === 404) {
        core.info(`Lease ${leaseId} already released or expired`);
      } else {
        const body = await response.readBody();
        core.warning(`Failed to release lease ${leaseId} (HTTP ${statusCode}): ${tryParseError(body)}`);
      }
    } catch (err) {
      core.warning(`Error releasing lease ${leaseId}: ${err}`);
    }
  }
}

function tryParseKobeError(body: string): KobeError | undefined {
  try {
    return JSON.parse(body) as KobeError;
  } catch {
    return undefined;
  }
}

function tryParseError(body: string): string {
  const parsed = tryParseKobeError(body);
  if (!parsed) return body;
  const base = parsed.error || parsed.message;
  if (!base) return body;
  const withDetail = parsed.detail ? `${base} — ${parsed.detail}` : base;
  return parsed.reason ? `${withDetail} [reason: ${parsed.reason}]` : withDetail;
}

/** Parse an RFC 9110 `Retry-After: <seconds>` header value to millis.
 * HTTP-date form and garbage both yield undefined (caller falls back
 * to its own backoff). */
function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return secs * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
