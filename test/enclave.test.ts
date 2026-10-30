import { VerificationError } from '@thinkr/verifier';
import { describe, expect, it } from 'vitest';
import { verifyEnclave } from '../src/enclave.js';
import { ThinkrError } from '../src/errors.js';
import { BASE_URL, jsonResponse, recordingFetch } from './fakes.js';

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('verifyEnclave', () => {
  it('asks the API for the bundle of the router', async () => {
    const send = recordingFetch([() => jsonResponse({ domain: 'enclave.example' })]);
    await failure(verifyEnclave({ baseURL: BASE_URL, fetch: send.fetch }));
    expect(send.seen.map((request) => request.url)).toEqual([`${BASE_URL}/attestation`]);
    expect(send.seen[0]?.headers.get('Authorization')).toBeNull();
  });

  it('fails at the step of the bundle when the bundle is incomplete or not JSON', async () => {
    for (const answer of [
      () => jsonResponse({ domain: 'enclave.example' }),
      () => new Response('not json', { status: 200 }),
    ]) {
      const send = recordingFetch([answer]);
      const error = await failure(verifyEnclave({ baseURL: BASE_URL, fetch: send.fetch }));
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).step).toBe('bundle');
    }
  });

  it('says so when the API gives no bundle', async () => {
    const down = recordingFetch([() => jsonResponse({}, 502)]);
    const downError = await failure(verifyEnclave({ baseURL: BASE_URL, fetch: down.fetch }));
    expect(downError).toBeInstanceOf(ThinkrError);
    expect((downError as ThinkrError).code).toBe('attestation_unavailable');

    const offline = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));
    const offlineError = await failure(verifyEnclave({ baseURL: BASE_URL, fetch: offline }));
    expect((offlineError as ThinkrError).code).toBe('attestation_unavailable');
  });

  it('stops on a base URL that would send in the clear', async () => {
    const send = recordingFetch([]);
    const error = await failure(
      verifyEnclave({ baseURL: 'http://api.example/v1', fetch: send.fetch }),
    );
    expect((error as ThinkrError).code).toBe('invalid_base_url');
    expect(send.seen).toHaveLength(0);
  });
});
