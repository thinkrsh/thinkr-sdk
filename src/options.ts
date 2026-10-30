import { API } from './config/api.js';
import { API_KEY } from './config/key.js';
import { ThinkrError } from './errors.js';

const API_KEY_PATTERN = new RegExp(
  `^${API_KEY.prefix}[${API_KEY.secretCharClass}]{${String(API_KEY.secretChars)}}$`,
);

/** Returns the key when it has the shape of an API key of Thinkr, and throws otherwise. */
export function checkApiKey(apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === '') {
    throw new ThinkrError(
      'invalid_api_key',
      `No API key was given. Create one at ${API.keysPage}.`,
    );
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new ThinkrError(
      'invalid_api_key',
      `An API key is ${API_KEY.prefix} followed by ${String(API_KEY.secretChars)} characters of base64url.`,
    );
  }
  return apiKey;
}

/**
 * Returns the base URL without a trailing slash. It must use HTTPS, or plain HTTP on the loopback
 * of this machine, since every request carries the API key.
 */
export function checkBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new ThinkrError('invalid_base_url', 'The base URL is not a URL.', { cause: error });
  }
  const loopback = API.loopbackHosts.some((host) => host === url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ThinkrError(
      'invalid_base_url',
      'The base URL must use HTTPS, except on the loopback of this machine.',
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ThinkrError(
      'invalid_base_url',
      'The base URL takes no credentials, query, or fragment.',
    );
  }
  return url.href.replace(/\/+$/, '');
}
