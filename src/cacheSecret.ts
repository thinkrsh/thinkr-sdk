import { CACHE_SECRET } from './config/verification.js';
import { toHex } from './lib/bytes.js';

/**
 * The secret that scopes the prompt cache of the enclave to one API key: HMAC-SHA-256 of a fixed
 * label under the key. It goes inside the sealed body only, and it does not reveal the key.
 */
export async function deriveCacheSecret(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(CACHE_SECRET.label));
  return toHex(new Uint8Array(mac));
}
