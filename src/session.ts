import type { Verification } from '@thinkr/verifier';

export interface EnclaveSessionDeps {
  /** Verifies the enclave from a fresh bundle; throws when any step fails. */
  readonly verify: () => Promise<Verification>;
  readonly now: () => number;
  /** How long a verification that passed stays good. */
  readonly maxAgeMs: number;
}

/** The verification that one client seals to. */
export interface EnclaveSession {
  /** A verification that passed and is still fresh. Verifies first when there is none. */
  readonly current: () => Promise<Verification>;
  /** Verifies again at once, as when the enclave answered that its key changed. */
  readonly renew: () => Promise<Verification>;
}

interface Kept {
  readonly verification: Verification;
  readonly at: number;
}

/**
 * Keeps the last verification that passed until it is `maxAgeMs` old or the certificate of the
 * enclave expires. Calls that come while a verification runs wait for that one, and a failed
 * verification is never kept, so the next call tries again.
 */
export function createEnclaveSession(deps: EnclaveSessionDeps): EnclaveSession {
  let kept: Kept | null = null;
  let running: Promise<Verification> | null = null;

  const isFresh = (entry: Kept): boolean => {
    const now = deps.now();
    return now - entry.at < deps.maxAgeMs && now < entry.verification.certificateNotAfter.getTime();
  };

  const verify = (): Promise<Verification> => {
    running ??= deps.verify().then(
      (verification) => {
        kept = { verification, at: deps.now() };
        running = null;
        return verification;
      },
      (error: unknown) => {
        running = null;
        throw error;
      },
    );
    return running;
  };

  return {
    current: () => (kept !== null && isFresh(kept) ? Promise.resolve(kept.verification) : verify()),
    renew: () => {
      kept = null;
      return verify();
    },
  };
}
