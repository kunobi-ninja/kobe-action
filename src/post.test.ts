import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';

// Pin the wiring contract of the post hook. The bug this guards against:
// v2 (and earlier) cached the OIDC token in `core.saveState('token', …)`
// from `main` and replayed it here. GitHub's runtime ID token is
// short-lived (≲10 min), so jobs that ran longer than the JWT's lifetime
// would 401 on `Releasing cluster` against an audience-validating kobe.
// These tests assert the post hook re-mints the token via
// `getOidcToken(audience)` instead — anyone reverting the wiring will
// fail the suite before it ships.
vi.mock('./oidc', () => ({
  getOidcToken: vi.fn(),
}));
vi.mock('./client', () => ({
  KobeClient: vi.fn(),
}));

import { getOidcToken } from './oidc';
import { KobeClient } from './client';
import { post } from './post';

const releaseLeaseMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  // Silence post's logging — every test path emits at least `core.info`.
  vi.spyOn(core, 'info').mockImplementation(() => {});
  vi.spyOn(core, 'warning').mockImplementation(() => {});

  releaseLeaseMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(KobeClient).mockImplementation(
    () => ({ releaseLease: releaseLeaseMock }) as unknown as KobeClient
  );
  vi.mocked(getOidcToken).mockResolvedValue('fresh-oidc-jwt');
});

function stubState(state: Record<string, string>): void {
  vi.spyOn(core, 'getState').mockImplementation((key: string) => state[key] ?? '');
}

describe('post hook', () => {
  it('mints a fresh OIDC token with the audience saved in state', async () => {
    stubState({
      'lease-id': 'lease-abc123',
      endpoint: 'https://kobe.example',
      audience: 'kobe-system',
    });

    await post();

    expect(getOidcToken).toHaveBeenCalledTimes(1);
    expect(getOidcToken).toHaveBeenCalledWith('kobe-system');
  });

  it('passes the freshly-minted token (not a state-cached one) to KobeClient', async () => {
    stubState({
      'lease-id': 'lease-abc123',
      endpoint: 'https://kobe.example',
      audience: 'kobe-system',
    });

    await post();

    expect(KobeClient).toHaveBeenCalledWith('https://kobe.example', 'fresh-oidc-jwt');
    expect(releaseLeaseMock).toHaveBeenCalledWith('lease-abc123');
  });

  it('defaults audience to "kobe-system" when state was written by an older main', async () => {
    // Backward-compat: state from a hypothetical older main.ts that
    // didn't save `audience` would return '' here. We must not pass
    // an empty audience to the OIDC endpoint (GitHub would reject it).
    stubState({
      'lease-id': 'lease-abc123',
      endpoint: 'https://kobe.example',
    });

    await post();

    expect(getOidcToken).toHaveBeenCalledWith('kobe-system');
  });

  it('uses a custom audience verbatim when main saved one', async () => {
    stubState({
      'lease-id': 'lease-abc123',
      endpoint: 'https://kobe.example',
      audience: 'kobe-staging',
    });

    await post();

    expect(getOidcToken).toHaveBeenCalledWith('kobe-staging');
  });

  it('skips release (no throw) when state has no lease — claim failed before saveState', async () => {
    stubState({});

    await post();

    expect(getOidcToken).not.toHaveBeenCalled();
    expect(KobeClient).not.toHaveBeenCalled();
  });

  it('warns and skips release when minting a fresh token throws', async () => {
    // If `id-token: write` was missing from the job perms, getOidcToken
    // throws. Post must not propagate — it runs in `always()` and
    // throwing would mark the cleanup as failed in the UI.
    stubState({
      'lease-id': 'lease-abc123',
      endpoint: 'https://kobe.example',
      audience: 'kobe-system',
    });
    vi.mocked(getOidcToken).mockRejectedValue(new Error('id-token not available'));
    const warn = vi.spyOn(core, 'warning').mockImplementation(() => {});

    await expect(post()).resolves.toBeUndefined();

    expect(KobeClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to mint OIDC token: id-token not available')
    );
  });
});
