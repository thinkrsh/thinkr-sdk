import type { Verification } from '@thinkr/verifier';
import { VerificationError } from '@thinkr/verifier';
import { describe, expect, it } from 'vitest';
import { createEnclaveSession } from '../src/session.js';
import { fakeVerification, manualClock } from './fakes.js';

const MAX_AGE_MS = 15 * 60 * 1000;

function countingVerify(results: (() => Promise<Verification>)[]): {
  verify: () => Promise<Verification>;
  calls: () => number;
} {
  let calls = 0;
  return {
    verify: () => {
      calls += 1;
      const next = results[calls - 1];
      if (next === undefined) throw new Error(`No result for verification ${String(calls)}.`);
      return next();
    },
    calls: () => calls,
  };
}

describe('createEnclaveSession', () => {
  it('verifies once while the verification is fresh', async () => {
    const clock = manualClock();
    const first = fakeVerification();
    const verifier = countingVerify([() => Promise.resolve(first)]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    expect(await session.current()).toBe(first);
    clock.advance(MAX_AGE_MS - 1);
    expect(await session.current()).toBe(first);
    expect(verifier.calls()).toBe(1);
  });

  it('verifies again once the verification is stale', async () => {
    const clock = manualClock();
    const first = fakeVerification({ releaseTag: 'v1' });
    const second = fakeVerification({ releaseTag: 'v2' });
    const verifier = countingVerify([() => Promise.resolve(first), () => Promise.resolve(second)]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    await session.current();
    clock.advance(MAX_AGE_MS);
    expect(await session.current()).toBe(second);
    expect(verifier.calls()).toBe(2);
  });

  it('verifies again once the certificate of the enclave expired', async () => {
    const clock = manualClock();
    const expiring = fakeVerification({ certificateNotAfter: new Date(clock.now() + 1_000) });
    const renewed = fakeVerification();
    const verifier = countingVerify([
      () => Promise.resolve(expiring),
      () => Promise.resolve(renewed),
    ]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    await session.current();
    clock.advance(1_000);
    expect(await session.current()).toBe(renewed);
  });

  it('lets calls that come together share one verification', async () => {
    const clock = manualClock();
    const only = fakeVerification();
    const verifier = countingVerify([() => Promise.resolve(only)]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    const results = await Promise.all([session.current(), session.current(), session.current()]);
    expect(results).toEqual([only, only, only]);
    expect(verifier.calls()).toBe(1);
  });

  it('keeps no failed verification, so the next call verifies again', async () => {
    const clock = manualClock();
    const passed = fakeVerification();
    const verifier = countingVerify([
      () => Promise.reject(new VerificationError('hardware', 'The report is not signed.')),
      () => Promise.resolve(passed),
    ]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    await expect(session.current()).rejects.toBeInstanceOf(VerificationError);
    expect(await session.current()).toBe(passed);
  });

  it('verifies again at once on renew, even while fresh', async () => {
    const clock = manualClock();
    const first = fakeVerification({ releaseTag: 'v1' });
    const second = fakeVerification({ releaseTag: 'v2' });
    const verifier = countingVerify([() => Promise.resolve(first), () => Promise.resolve(second)]);
    const session = createEnclaveSession({ ...verifier, now: clock.now, maxAgeMs: MAX_AGE_MS });
    await session.current();
    expect(await session.renew()).toBe(second);
    expect(await session.current()).toBe(second);
    expect(verifier.calls()).toBe(2);
  });
});
