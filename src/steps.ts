import {
  openResponseBytes,
  sealRequestBody,
  TINFOIL,
  type SealedRequestBody,
  type Verification,
} from '@thinkr/verifier';
import { deriveCacheSecret } from './cacheSecret.js';
import { API } from './config/api.js';
import { BRIDGE } from './config/bridge.js';
import { ThinkrError } from './errors.js';
import { isRecord } from './lib/json.js';
import { checkApiKey } from './options.js';
import { modelOf } from './sealing.js';

/** What a tool sends to the API itself: the ciphertext of a chat, and where and how it goes. */
export interface EncryptedChat {
  /** Names the secrets of this chat at the bridge, for the step that decrypts its answer. */
  readonly id: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The encrypted frames, in base64url. */
  readonly body: string;
}

export interface ChatStepsDeps {
  /** The base URL that `checkBaseUrl` returned. */
  readonly baseUrl: string;
  /** Verifies the enclave from a fresh bundle; throws when any step fails. */
  readonly verify: () => Promise<Verification>;
  readonly now: () => number;
  readonly newId: () => string;
}

/** A chat in steps, for a tool that sends the ciphertext to the API itself. */
export interface ChatSteps {
  readonly encrypt: (apiKey: string, body: Uint8Array) => Promise<EncryptedChat>;
  readonly decrypt: (id: string, nonce: string, ciphertext: string) => Promise<Uint8Array>;
}

interface Waiting {
  readonly sealed: SealedRequestBody;
  readonly at: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The steps of an encrypted chat on this machine. Each chat verifies the enclave afresh, since the
 * caller sends it later and cannot verify again by itself. The secrets of its answer stay here, in
 * memory, until the answer opens or their time ends.
 */
export function createChatSteps(deps: ChatStepsDeps): ChatSteps {
  const waiting = new Map<string, Waiting>();

  const dropOld = (): void => {
    for (const [id, entry] of waiting) {
      if (deps.now() - entry.at >= BRIDGE.stepTtlMs) waiting.delete(id);
    }
    while (waiting.size >= BRIDGE.maxStepsKept) {
      const [oldest] = waiting.keys();
      if (oldest === undefined) break;
      waiting.delete(oldest);
    }
  };

  return {
    encrypt: async (apiKey, body) => {
      const secret = await deriveCacheSecret(checkApiKey(apiKey));
      const model = modelOf(body);
      const plaintext = chatWithCacheSecret(body, secret);
      const verification = await deps.verify();
      const sealed = await sealRequestBody(verification.hardware.hpkePublicKey, plaintext);
      dropOld();
      const id = deps.newId();
      waiting.set(id, { sealed, at: deps.now() });
      return {
        id,
        url: `${deps.baseUrl}${API.chatPath}`,
        headers: {
          ...sealed.headers,
          'Content-Type': 'application/json',
          [API.modelHeader]: model,
          [TINFOIL.enclaveUrlHeader]: `${API.enclaveScheme}//${verification.enclaveHost}`,
          [API.bodyEncodingHeader]: API.bodyEncoding,
        },
        body: Buffer.from(sealed.body).toString('base64url'),
      };
    },
    decrypt: async (id, nonce, ciphertext) => {
      dropOld();
      const entry = waiting.get(id);
      if (entry === undefined) {
        throw new ThinkrError(
          'invalid_request',
          'This id is not known here, or its time ended. Encrypt the chat again.',
        );
      }
      if (!BASE64URL.test(ciphertext)) {
        throw new ThinkrError('invalid_request', 'The ciphertext is not valid base64url.');
      }
      const framed = new Uint8Array(Buffer.from(ciphertext, 'base64url'));
      const opened = await openResponseBytes(entry.sealed, nonce, framed);
      waiting.delete(id);
      return opened;
    },
  };
}

/**
 * The JSON of a chat with the cache secret inside the seal, as the client adds it. A chat in steps
 * takes its answer whole, so it refuses a stream.
 */
function chatWithCacheSecret(body: Uint8Array, secret: string): Uint8Array {
  const parsed: unknown = JSON.parse(decoder.decode(body));
  if (!isRecord(parsed)) throw new ThinkrError('invalid_request', 'A request body must be JSON.');
  if (parsed.stream === true) {
    throw new ThinkrError(
      'invalid_request',
      `A chat in steps has no stream. To stream, send it to ${BRIDGE.chatPath}.`,
    );
  }
  return encoder.encode(JSON.stringify({ [TINFOIL.cacheSecretField]: secret, ...parsed }));
}
