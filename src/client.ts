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
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff

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
    const body = JSON.stringify({ pool, ttl });

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const response = await this.http.post(url, body);
      const responseBody = await response.readBody();
      const statusCode = response.message.statusCode ?? 0;

      if (statusCode >= 200 && statusCode < 300) {
        return JSON.parse(responseBody) as LeaseResponse;
      }

      if (statusCode === 503 && attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        core.info(`Pool exhausted (503), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${RETRY_DELAYS.length})`);
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

function tryParseError(body: string): string {
  try {
    const parsed = JSON.parse(body) as KobeError;
    return parsed.error || parsed.message || body;
  } catch {
    return body;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
