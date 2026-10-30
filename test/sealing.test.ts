import type { Verification } from '@thinkr/verifier';
import { VerificationError } from '@thinkr/verifier';
import { describe, expect, it } from 'vitest';
import { ThinkrError } from '../src/errors.js';
import { createClientFetch } from '../src/sealing.js';
import type { EnclaveSession } from '../src/session.js';
import {
  BASE_URL,
  fakeVerification,
  fixedSession,
  jsonResponse,
  keyConfigProblem,
  recordingFetch,
} from './fakes.js';

const CHAT_URL = `${BASE_URL}/chat/completions`;
const CHAT_BODY = JSON.stringify({ model: 'gpt-oss-120b', messages: [] });

/** A seal that records which verification each sealed request used, and sends with `send`. */
function recordingSeal(send: typeof fetch): {
  seal: (verification: Verification) => Promise<typeof fetch>;
  used: Verification[];
} {
  const used: Verification[] = [];
  return {
    used,
    seal: (verification) => {
      used.push(verification);
      return Promise.resolve(send);
    },
  };
}

function failingSession(): EnclaveSession {
  const fail = (): Promise<Verification> =>
    Promise.reject(new VerificationError('code', 'The release is not signed.'));
  return { current: fail, renew: fail };
}

describe('createClientFetch', () => {
  it('names the model of the body in the model header, and drops the headers of the machine', async () => {
    const sealed = recordingFetch([() => jsonResponse({ ok: true })]);
    const plain = recordingFetch([]);
    const { seal } = recordingSeal(sealed.fetch);
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session: fixedSession(fakeVerification()),
      seal,
      send: plain.fetch,
    });
    const response = await send(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer key',
        'Content-Type': 'application/json',
        'X-Stainless-OS': 'MacOS',
        'x-stainless-runtime-version': 'v22.12.0',
      },
      body: CHAT_BODY,
    });
    expect(response.status).toBe(200);
    const [request] = sealed.seen;
    expect(request?.headers.get('X-Tinfoil-Model')).toBe('gpt-oss-120b');
    expect(request?.headers.get('Authorization')).toBe('Bearer key');
    expect(request?.headers.get('x-stainless-os')).toBeNull();
    expect(request?.headers.get('x-stainless-runtime-version')).toBeNull();
    expect(request?.body).toBe(CHAT_BODY);
    expect(plain.seen).toHaveLength(0);
  });

  it('sends nothing when the verification fails', async () => {
    const sealed = recordingFetch([]);
    const plain = recordingFetch([]);
    const { seal, used } = recordingSeal(sealed.fetch);
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session: failingSession(),
      seal,
      send: plain.fetch,
    });
    await expect(
      send(CHAT_URL, { method: 'POST', body: CHAT_BODY, headers: { Authorization: 'Bearer key' } }),
    ).rejects.toBeInstanceOf(VerificationError);
    expect(used).toHaveLength(0);
    expect(sealed.seen).toHaveLength(0);
    expect(plain.seen).toHaveLength(0);
  });

  it('sends a request with no body as it is, with no verification', async () => {
    const plain = recordingFetch([() => jsonResponse({ object: 'list', data: [] })]);
    const session = fixedSession(fakeVerification());
    const { seal, used } = recordingSeal(recordingFetch([]).fetch);
    const send = createClientFetch({ baseUrl: BASE_URL, session, seal, send: plain.fetch });
    const response = await send(`${BASE_URL}/models`, {
      headers: { Authorization: 'Bearer key', 'X-Stainless-Arch': 'arm64' },
    });
    expect(await response.json()).toEqual({ object: 'list', data: [] });
    expect(plain.seen[0]?.url).toBe(`${BASE_URL}/models`);
    expect(plain.seen[0]?.headers.get('Authorization')).toBe('Bearer key');
    expect(plain.seen[0]?.headers.get('x-stainless-arch')).toBeNull();
    expect(session.counts.current).toBe(0);
    expect(used).toHaveLength(0);
  });

  it('refuses another origin, which would get the API key', async () => {
    const plain = recordingFetch([]);
    const sealed = recordingFetch([]);
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session: fixedSession(fakeVerification()),
      seal: recordingSeal(sealed.fetch).seal,
      send: plain.fetch,
    });
    await expect(send('https://elsewhere.example/v1/models')).rejects.toBeInstanceOf(ThinkrError);
    await expect(
      send('https://elsewhere.example/v1/chat/completions', { method: 'POST', body: CHAT_BODY }),
    ).rejects.toBeInstanceOf(ThinkrError);
    expect(plain.seen).toHaveLength(0);
    expect(sealed.seen).toHaveLength(0);
  });

  it('refuses a body that is not JSON or names no model, before it seals', async () => {
    const sealed = recordingFetch([]);
    const session = fixedSession(fakeVerification());
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session,
      seal: recordingSeal(sealed.fetch).seal,
      send: recordingFetch([]).fetch,
    });
    for (const body of ['not json', JSON.stringify({ messages: [] }), JSON.stringify(['a'])]) {
      await expect(send(CHAT_URL, { method: 'POST', body })).rejects.toBeInstanceOf(ThinkrError);
    }
    expect(session.counts.current).toBe(0);
    expect(sealed.seen).toHaveLength(0);
  });

  it('verifies again and sends once more when the enclave changed its key', async () => {
    const sealed = recordingFetch([keyConfigProblem, () => jsonResponse({ ok: true })]);
    const session = fixedSession(fakeVerification());
    const { seal, used } = recordingSeal(sealed.fetch);
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session,
      seal,
      send: recordingFetch([]).fetch,
    });
    const response = await send(CHAT_URL, { method: 'POST', body: CHAT_BODY });
    expect(await response.json()).toEqual({ ok: true });
    expect(session.counts).toEqual({ current: 1, renew: 1 });
    expect(used).toHaveLength(2);
    expect(sealed.seen.map((request) => request.body)).toEqual([CHAT_BODY, CHAT_BODY]);
  });

  it('passes any other problem on whole, with no second try', async () => {
    const other = {
      type: 'urn:example:other',
      title: 'Something else',
    };
    const sealed = recordingFetch([
      () =>
        new Response(JSON.stringify(other), {
          status: 422,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    ]);
    const session = fixedSession(fakeVerification());
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session,
      seal: recordingSeal(sealed.fetch).seal,
      send: recordingFetch([]).fetch,
    });
    const response = await send(CHAT_URL, { method: 'POST', body: CHAT_BODY });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(other);
    expect(session.counts.renew).toBe(0);
  });

  it('passes an error of the API on whole', async () => {
    const error = { error: { code: 'balance_low', message: 'Not enough credit.' } };
    const sealed = recordingFetch([() => jsonResponse(error, 402)]);
    const send = createClientFetch({
      baseUrl: BASE_URL,
      session: fixedSession(fakeVerification()),
      seal: recordingSeal(sealed.fetch).seal,
      send: recordingFetch([]).fetch,
    });
    const response = await send(CHAT_URL, { method: 'POST', body: CHAT_BODY });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual(error);
  });
});
