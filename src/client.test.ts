import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import * as core from '@actions/core';
import { KobeClient, type LeaseResponse } from './client';

// Wire-shape contract tests for `KobeClient`. These pin the request body
// and headers the action sends to kobe — the 422 we hit shipping
// v2.1.0 (sent `{ pool, ttl }` instead of `{ profile, ttl }`) would
// have failed `createLease > sends a body of exactly { profile, ttl }`
// instead of escaping to consumers.
//
// Timing strategy: we deliberately avoid `vi.useFakeTimers()` —
// vitest's fake timers conflict with `@actions/http-client`'s socket
// callbacks (it relies on `setTimeout`/`setImmediate` internally for
// request lifecycle), and combining the two deadlocks. Instead we stub
// the global `setTimeout` to fire its callback immediately, which
// collapses both the retry sleeps (`RETRY_DELAYS`) and the polling
// gaps in `waitForBind` to ~0ms while leaving the http-client's own
// internal timers untouched. None of these tests assert on actual
// delay durations — only that retries / polls happen and final
// outcomes are correct.

const ENDPOINT = 'http://kobe.test';
const TOKEN = 'test-token';

/**
 * Replace `setTimeout` with a no-wait passthrough for the duration of
 * a single test. The KobeClient's `sleep()` helper is a thin wrapper
 * over `setTimeout(resolve, ms)`; this collapses every retry/poll
 * sleep to a microtask. The original is restored in `afterEach`.
 */
function instantSleep(): void {
  vi.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
    // Fire on the microtask queue so promise chains still get a chance
    // to run between iterations (mirrors real setTimeout 0).
    queueMicrotask(cb);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
}

const lease = (overrides: Partial<LeaseResponse> = {}): LeaseResponse => ({
  id: 'lease-aceac0bbb7df1234',
  phase: 'Pending',
  ...overrides,
});

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  // Silence core.info / core.warning during tests — KobeClient logs on
  // every retry / release, and the noise drowns the test runner output.
  vi.spyOn(core, 'info').mockImplementation(() => {});
  vi.spyOn(core, 'warning').mockImplementation(() => {});
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('KobeClient.createLease', () => {
  it('sends a body of exactly { profile, ttl } with the bearer token', async () => {
    // The contract pin: this is the test that would have caught the
    // v2.1.0 → v2.1.1 fix. Body shape is matched exactly — nock
    // resolves the interceptor only if every key matches and no extras
    // appear.
    const scope = nock(ENDPOINT, {
      reqheaders: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': /^application\/json/,
      },
    })
      .post('/v1/leases', (body: Record<string, unknown>) => {
        // Strict equality: no extra keys, no missing keys.
        const keys = Object.keys(body).sort();
        return (
          keys.length === 2 &&
          keys[0] === 'profile' &&
          keys[1] === 'ttl' &&
          body.profile === 'ci-small' &&
          body.ttl === '1h'
        );
      })
      .reply(200, lease({ id: 'lease-abc', phase: 'Bound' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    const result = await client.createLease('ci-small', '1h');

    expect(result).toMatchObject({ id: 'lease-abc', phase: 'Bound' });
    expect(scope.isDone()).toBe(true);
  });

  it('strips a trailing slash from the endpoint before joining /v1/leases', async () => {
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(200, lease({ id: 'lease-1' }));

    const client = new KobeClient(`${ENDPOINT}/`, TOKEN);
    await client.createLease('ci-small', '1h');
    expect(scope.isDone()).toBe(true);
  });

  it('retries once after a 503 and succeeds on the second attempt', async () => {
    instantSleep();
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(503, { error: 'pool exhausted' })
      .post('/v1/leases')
      .reply(200, lease({ id: 'lease-after-retry', phase: 'Bound' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    const result = await client.createLease('ci-small', '1h');

    expect(result).toMatchObject({ id: 'lease-after-retry' });
    expect(scope.isDone()).toBe(true);
  });

  it('honours the exponential backoff progression on consecutive 503s', async () => {
    instantSleep();
    // RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]. Five 503 retries
    // followed by a success — total 6 attempts. We can't observe the
    // backoff *durations* under instant-sleep, but we can pin that the
    // client retries exactly as many times as RETRY_DELAYS allows.
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(503)
      .post('/v1/leases')
      .reply(503)
      .post('/v1/leases')
      .reply(503)
      .post('/v1/leases')
      .reply(503)
      .post('/v1/leases')
      .reply(503)
      .post('/v1/leases')
      .reply(200, lease({ id: 'lease-survived', phase: 'Bound' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    const result = await client.createLease('ci-small', '1h');

    expect(result).toMatchObject({ id: 'lease-survived' });
    // All six interceptors consumed proves the retry walked the full
    // RETRY_DELAYS sequence (5 retries) before succeeding on attempt 6.
    expect(scope.isDone()).toBe(true);
  });

  it('throws after exhausting all 503 retries', async () => {
    instantSleep();
    // RETRY_DELAYS.length = 5, so the loop runs attempts 0..5 inclusive
    // (6 total). After 6 consecutive 503s, it gives up.
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .times(6)
      .reply(503, { error: 'pool exhausted' });

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /HTTP 503.*pool exhausted/
    );
    expect(scope.isDone()).toBe(true);
  });

  it('surfaces the server detail and reason from a 503 body', async () => {
    instantSleep();
    const detail =
      'no Ready cluster; pool ci-small phase=Failing, consecutiveFailures=10, ' +
      'lastFailureReason=10 instance(s) not reaching Ready';
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .times(6)
      .reply(
        503,
        { error: 'Pool cannot satisfy a new lease', detail, reason: 'pool_exhausted' },
        { 'Retry-After': '30' }
      );

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /HTTP 503.*Pool cannot satisfy a new lease — no Ready cluster.*\[reason: pool_exhausted\]/
    );

    // The operator diagnosis is logged once (deduped across retries),
    // so a CI reader sees *why* instead of a bare status code.
    const warnings = vi.mocked(core.warning).mock.calls.map(c => String(c[0]));
    expect(warnings.filter(w => w.includes('consecutiveFailures=10'))).toHaveLength(1);
    // The per-retry line names the machine-readable reason.
    const infos = vi.mocked(core.info).mock.calls.map(c => String(c[0]));
    expect(infos.some(i => i.includes('503, pool_exhausted'))).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('honours Retry-After for the retry delay, capped at 30s', async () => {
    // No instantSleep: capture the requested delays directly by stubbing
    // setTimeout to record ms and fire immediately.
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      queueMicrotask(cb);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(503, { error: 'x' }, { 'Retry-After': '7' })
      .post('/v1/leases')
      .reply(503, { error: 'x' }, { 'Retry-After': '600' })
      .post('/v1/leases')
      .reply(200, lease({ id: 'lease-ra', phase: 'Bound' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    await client.createLease('ci-small', '1h');

    // Attempt 1: server's 7s beats the 1s base backoff. Attempt 2:
    // server's 600s is capped at 30s.
    expect(delays).toEqual([7000, 30000]);
    expect(scope.isDone()).toBe(true);
  });

  it('throws immediately on 422 with no retry', async () => {
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(422, { error: 'missing field "profile"' });
    // Set up a second interceptor that should NEVER be consumed —
    // verifies no retry happened on the non-retryable status.
    const noRetry = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(200, lease());

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /HTTP 422.*missing field "profile"/
    );

    expect(scope.isDone()).toBe(true);
    expect(noRetry.isDone()).toBe(false);
    expect(nock.pendingMocks().length).toBeGreaterThan(0);
    // Tidy up so afterEach cleanAll's pending count is zero.
    nock.cleanAll();
  });

  it('throws immediately on 401 with no retry', async () => {
    const scope = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(401, { message: 'invalid token' });
    const noRetry = nock(ENDPOINT)
      .post('/v1/leases')
      .reply(200, lease());

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /HTTP 401.*invalid token/
    );

    expect(scope.isDone()).toBe(true);
    expect(noRetry.isDone()).toBe(false);
    nock.cleanAll();
  });

  it('surfaces the `error` field from the server envelope', async () => {
    nock(ENDPOINT)
      .post('/v1/leases')
      .reply(422, { error: 'missing field "profile"' });

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /missing field "profile"/
    );
  });

  it('surfaces the `message` field from the server envelope', async () => {
    nock(ENDPOINT)
      .post('/v1/leases')
      .reply(400, { message: 'malformed ttl' });

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /malformed ttl/
    );
  });

  it('surfaces a non-JSON error body verbatim', async () => {
    nock(ENDPOINT).post('/v1/leases').reply(500, '<html>oops</html>');

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.createLease('ci-small', '1h')).rejects.toThrow(
      /<html>oops<\/html>/
    );
  });
});

describe('KobeClient.getLease', () => {
  it('returns the parsed lease on 200', async () => {
    nock(ENDPOINT)
      .get('/v1/leases/lease-abc')
      .reply(200, lease({ id: 'lease-abc', phase: 'Bound', kubeconfig: 'apiVersion: v1' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    const result = await client.getLease('lease-abc');
    expect(result).toMatchObject({ id: 'lease-abc', phase: 'Bound' });
  });

  it('throws on 404', async () => {
    nock(ENDPOINT)
      .get('/v1/leases/lease-missing')
      .reply(404, { error: 'lease not found' });

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.getLease('lease-missing')).rejects.toThrow(
      /HTTP 404.*lease not found/
    );
  });
});

describe('KobeClient.waitForBind', () => {
  it('returns the bound lease after polling Pending → Pending → Bound', async () => {
    instantSleep();
    const scope = nock(ENDPOINT)
      .get('/v1/leases/lease-x')
      .reply(200, lease({ id: 'lease-x', phase: 'Pending' }))
      .get('/v1/leases/lease-x')
      .reply(200, lease({ id: 'lease-x', phase: 'Pending' }))
      .get('/v1/leases/lease-x')
      .reply(200, lease({ id: 'lease-x', phase: 'Bound', kubeconfig: 'kc' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    const result = await client.waitForBind('lease-x', 60_000);
    expect(result).toMatchObject({ id: 'lease-x', phase: 'Bound' });
    // All three interceptors consumed proves the loop polled exactly
    // 3 times (2 Pending + 1 Bound) before returning.
    expect(scope.isDone()).toBe(true);
  });

  it.each(['Expired', 'Released', 'Recycling'])(
    'throws when the lease enters terminal phase %s',
    async (phase) => {
      nock(ENDPOINT)
        .get('/v1/leases/lease-bad')
        .reply(200, lease({ id: 'lease-bad', phase }));

      const client = new KobeClient(ENDPOINT, TOKEN);
      await expect(client.waitForBind('lease-bad', 5_000)).rejects.toThrow(
        new RegExp(`unexpected phase: ${phase}`)
      );
    }
  );

  it('throws a timeout error when the lease never binds within the deadline', async () => {
    // No instantSleep here — we need real wall-clock to advance past
    // the deadline. Use a tiny 100ms timeout so the test is fast.
    // Persistent Pending — `persist()` lets the same interceptor match
    // every poll instead of needing `times(N)`.
    nock(ENDPOINT)
      .persist()
      .get('/v1/leases/lease-slow')
      .reply(200, lease({ id: 'lease-slow', phase: 'Pending' }));

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.waitForBind('lease-slow', 100)).rejects.toThrow(
      /Timed out waiting for lease lease-slow/
    );
  });
});

describe('KobeClient.releaseLease', () => {
  it('resolves quietly on a 200 DELETE', async () => {
    nock(ENDPOINT).delete('/v1/leases/lease-x').reply(200);

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.releaseLease('lease-x')).resolves.toBeUndefined();
  });

  it('resolves quietly on 404 (idempotent)', async () => {
    nock(ENDPOINT).delete('/v1/leases/lease-gone').reply(404);

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.releaseLease('lease-gone')).resolves.toBeUndefined();
  });

  it('resolves quietly on 5xx — post-hook safety, never throws', async () => {
    nock(ENDPOINT)
      .delete('/v1/leases/lease-x')
      .reply(500, { error: 'internal' });

    const client = new KobeClient(ENDPOINT, TOKEN);
    // The post-hook calls releaseLease in a `finally`-like path; if it
    // ever threw, the action's job-cleanup story would break loudly on
    // every transient kobe outage. Pin it here.
    await expect(client.releaseLease('lease-x')).resolves.toBeUndefined();
  });

  it('resolves quietly on a network error', async () => {
    // String form of replyWithError: nock emits this as an `Error` event
    // on the request and http-client rejects its promise. (The object
    // form `{ code, message }` keeps the socket open in http-client's
    // current implementation, which is a separate plumbing issue.)
    nock(ENDPOINT)
      .delete('/v1/leases/lease-x')
      .replyWithError('ECONNRESET: connection reset');

    const client = new KobeClient(ENDPOINT, TOKEN);
    await expect(client.releaseLease('lease-x')).resolves.toBeUndefined();
  });
});
