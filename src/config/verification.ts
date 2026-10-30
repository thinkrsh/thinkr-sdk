import { TINFOIL } from '@thinkr/verifier';

/** How the SDK verifies the enclave before it seals a request to it. */
export const VERIFICATION = {
  /** The repository whose signed releases the router must run. */
  routerRepo: TINFOIL.routerRepo,
  /**
   * How long a verification that passed stays good: 15 minutes. A verification fetches the bundle
   * and checks the report of AMD and the release in Sigstore, which takes longer than a short chat,
   * so a client verifies again only after this time. A key that changes sooner does not wait for
   * it: the key-configuration problem of EHBP makes the client verify again at once.
   */
  maxAgeMs: 15 * 60 * 1000,
} as const;

/**
 * The secret that scopes the prompt cache of the enclave to one API key. The SDK derives it from
 * the key with HMAC-SHA-256 and seals it inside each chat body, so only the enclave reads it. The
 * chat app of Thinkr does the same with a secret of each browser.
 */
export const CACHE_SECRET = {
  label: 'thinkr sdk prompt cache v1',
} as const;
