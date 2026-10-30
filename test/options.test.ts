import { describe, expect, it } from 'vitest';
import { ThinkrError } from '../src/errors.js';
import { checkApiKey, checkBaseUrl } from '../src/options.js';
import { API_KEY } from './fakes.js';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ThinkrError) return error.code;
    throw error;
  }
  return undefined;
}

describe('checkApiKey', () => {
  it('takes a key of the right shape', () => {
    expect(checkApiKey(API_KEY)).toBe(API_KEY);
    expect(checkApiKey(`thkr_${'Az09_-'.repeat(7)}x`)).toMatch(/^thkr_/);
  });

  it('stops on a missing key', () => {
    expect(codeOf(() => checkApiKey(undefined))).toBe('invalid_api_key');
    expect(codeOf(() => checkApiKey(''))).toBe('invalid_api_key');
  });

  it('stops on a key of another shape, and never repeats the key', () => {
    const wrong = [
      `sk-${'a'.repeat(43)}`,
      `thkr_${'a'.repeat(42)}`,
      `thkr_${'a'.repeat(44)}`,
      `thkr_${'a'.repeat(42)}!`,
      ` thkr_${'a'.repeat(43)}`,
    ];
    for (const key of wrong) {
      expect(codeOf(() => checkApiKey(key))).toBe('invalid_api_key');
      expect(() => checkApiKey(key)).not.toThrow(key);
    }
  });
});

describe('checkBaseUrl', () => {
  it('takes HTTPS and drops a trailing slash', () => {
    expect(checkBaseUrl('https://api.thinkr.sh/v1/')).toBe('https://api.thinkr.sh/v1');
    expect(checkBaseUrl('https://api.thinkr.sh/v1')).toBe('https://api.thinkr.sh/v1');
  });

  it('takes plain HTTP on the loopback only', () => {
    expect(checkBaseUrl('http://127.0.0.1:8787/api/inference/v1')).toBe(
      'http://127.0.0.1:8787/api/inference/v1',
    );
    expect(checkBaseUrl('http://localhost:8787/api/inference/v1')).toMatch(/^http:\/\/localhost/);
    expect(checkBaseUrl('http://[::1]:8787/v1')).toBe('http://[::1]:8787/v1');
    expect(codeOf(() => checkBaseUrl('http://api.thinkr.sh/v1'))).toBe('invalid_base_url');
    expect(codeOf(() => checkBaseUrl('http://10.0.0.2:8787/v1'))).toBe('invalid_base_url');
  });

  it('stops on what is not a plain base URL', () => {
    expect(codeOf(() => checkBaseUrl('api.thinkr.sh/v1'))).toBe('invalid_base_url');
    expect(codeOf(() => checkBaseUrl('ftp://api.thinkr.sh/v1'))).toBe('invalid_base_url');
    expect(codeOf(() => checkBaseUrl('https://api.thinkr.sh/v1?x=1'))).toBe('invalid_base_url');
    expect(codeOf(() => checkBaseUrl('https://user:pass@api.thinkr.sh/v1'))).toBe(
      'invalid_base_url',
    );
  });
});
