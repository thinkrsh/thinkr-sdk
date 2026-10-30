import {
  parseBundle,
  verifyBundle,
  VerificationError,
  type AttestationBundle,
  type Verification,
} from '@thinkr/verifier';
import { API } from './config/api.js';
import { VERIFICATION } from './config/verification.js';
import { ThinkrError } from './errors.js';
import { checkBaseUrl } from './options.js';

export interface VerifyEnclaveOptions {
  /** The base URL of the API: https://api.thinkr.sh/v1 by default. */
  readonly baseURL?: string;
  /** The fetch to send with: the global fetch by default. */
  readonly fetch?: typeof fetch;
}

/**
 * Fetches the attestation bundle of the router through the API and verifies it on this machine:
 * the report of AMD SEV-SNP, the signed release in Sigstore, the measurement, and the keys of the
 * certificate. Throws the `VerificationError` of `@thinkr/verifier`, which names the step that
 * failed, or a `ThinkrError` when the API gives no bundle.
 */
export async function verifyEnclave(options: VerifyEnclaveOptions = {}): Promise<Verification> {
  const baseUrl = checkBaseUrl(options.baseURL ?? API.defaultBaseUrl);
  return verifyRouter(baseUrl, options.fetch ?? globalThis.fetch.bind(globalThis));
}

/** Verifies the router behind a base URL that `checkBaseUrl` returned. */
export async function verifyRouter(baseUrl: string, send: typeof fetch): Promise<Verification> {
  const json = await fetchBundleJson(baseUrl, send);
  let bundle: AttestationBundle;
  try {
    bundle = parseBundle(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VerificationError('bundle', message, { cause: error });
  }
  return verifyBundle(bundle, { repo: VERIFICATION.routerRepo });
}

async function fetchBundleJson(baseUrl: string, send: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await send(`${baseUrl}${API.attestationPath}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new ThinkrError(
      'attestation_unavailable',
      'The attestation of the enclave could not be fetched.',
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new ThinkrError(
      'attestation_unavailable',
      `The API answered ${String(response.status)} for the attestation of the enclave.`,
    );
  }
  try {
    const json: unknown = await response.json();
    return json;
  } catch (error) {
    throw new VerificationError('bundle', 'The attestation bundle is not JSON.', { cause: error });
  }
}
