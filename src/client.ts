import { createSealedFetch, type SealedFetchOptions, type Verification } from '@thinkr/verifier';
import OpenAI from 'openai';
import { deriveCacheSecret } from './cacheSecret.js';
import { API } from './config/api.js';
import { VERIFICATION } from './config/verification.js';
import { verifyRouter } from './enclave.js';
import { checkApiKey, checkBaseUrl } from './options.js';
import { createClientFetch } from './sealing.js';
import { createEnclaveSession } from './session.js';

export interface ClientOptions {
  /**
   * The API key from chat.thinkr.sh/keys. The SDK throws when it is missing or has another
   * shape, so `process.env.THINKR_API_KEY` can go here as it is.
   */
  readonly apiKey: string | undefined;
  /** The base URL of the API: https://api.thinkr.sh/v1 by default. */
  readonly baseURL?: string;
  /** The fetch to send with: the global fetch by default. */
  readonly fetch?: typeof fetch;
}

/** What a client is built on. The tests put fakes in their place. */
export interface ClientDeps {
  readonly verify: (baseUrl: string, send: typeof fetch) => Promise<Verification>;
  readonly seal: (options: SealedFetchOptions) => typeof fetch;
  readonly now: () => number;
}

const LIVE: ClientDeps = {
  verify: verifyRouter,
  seal: createSealedFetch,
  now: () => Date.now(),
};

/**
 * An OpenAI client for Thinkr Inference. Before its first request with a body, it verifies the
 * enclave on this machine, and it verifies again once that verification is older than 15 minutes or
 * the enclave changed its key. It seals each request body to the key of the verified enclave, so
 * the proxy of Thinkr and every other server on the way see ciphertext only.
 */
export function createClient(options: ClientOptions): OpenAI {
  return buildClient(options, LIVE);
}

/** `createClient` with its dependencies named. */
export function buildClient(options: ClientOptions, deps: ClientDeps): OpenAI {
  const apiKey = checkApiKey(options.apiKey);
  const baseUrl = checkBaseUrl(options.baseURL ?? API.defaultBaseUrl);
  return new OpenAI({ apiKey, baseURL: baseUrl, fetch: buildFetch(options, deps) });
}

/**
 * The fetch under a client, for one API key: it verifies the enclave and seals each request body,
 * and so serves any caller of plain HTTP on this machine too, as the local bridge does.
 */
export function buildFetch(options: ClientOptions, deps: ClientDeps = LIVE): typeof fetch {
  const apiKey = checkApiKey(options.apiKey);
  const baseUrl = checkBaseUrl(options.baseURL ?? API.defaultBaseUrl);
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const session = createEnclaveSession({
    verify: () => deps.verify(baseUrl, send),
    now: deps.now,
    maxAgeMs: VERIFICATION.maxAgeMs,
  });
  let cacheSecret: Promise<string> | null = null;
  return createClientFetch({
    baseUrl,
    session,
    send,
    seal: async (verification) =>
      deps.seal({
        hpkePublicKey: verification.hardware.hpkePublicKey,
        baseUrl,
        enclaveUrl: `${API.enclaveScheme}//${verification.enclaveHost}`,
        cacheSecret: await (cacheSecret ??= deriveCacheSecret(apiKey)),
        fetch: send,
      }),
  });
}
