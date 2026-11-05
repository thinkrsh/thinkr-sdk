import { createSealedFetch, VerificationError } from '@thinkr/verifier';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge, type BridgeDeps, type BridgeHandler } from '../src/bridge.js';
import { buildFetch, type ClientDeps } from '../src/client.js';
import { startBridgeServer } from '../src/serve.js';
import { createChatSteps, type EncryptedChat } from '../src/steps.js';
import {
  API_KEY,
  BASE_URL,
  chatCompletion,
  chatStreamEvents,
  fakeVerification,
  jsonResponse,
  manualClock,
  recordingFetch,
} from './fakes.js';
import { TestEnclave, type EnclaveAnswer } from './testEnclave.js';

const LOCAL = 'http://127.0.0.1:4141';
const CHAT_BODY = { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'Hello' }] };

function sealedJson(body: unknown): EnclaveAnswer {
  return { status: 200, contentType: 'application/json', frames: [JSON.stringify(body)] };
}

/** The fetch of a client on the real seal, pointed at a test enclave. */
function clientDeps(enclave: TestEnclave): ClientDeps {
  return {
    verify: () =>
      Promise.resolve(
        fakeVerification({
          hardware: { ...fakeVerification().hardware, hpkePublicKey: enclave.publicKeyHex },
        }),
      ),
    seal: createSealedFetch,
    now: manualClock().now,
  };
}

function stepsOn(enclave: TestEnclave, now: () => number = manualClock().now): BridgeDeps['steps'] {
  let ids = 0;
  return createChatSteps({
    baseUrl: BASE_URL,
    verify: () => clientDeps(enclave).verify(BASE_URL, enclave.fetch),
    now,
    newId: () => {
      ids += 1;
      return `chat-${String(ids)}`;
    },
  });
}

function bridgeOn(enclave: TestEnclave, send: typeof fetch = enclave.fetch): BridgeHandler {
  const deps: BridgeDeps = {
    baseUrl: BASE_URL,
    send,
    steps: stepsOn(enclave),
    chatFetch: (apiKey) =>
      buildFetch({ apiKey, baseURL: BASE_URL, fetch: enclave.fetch }, clientDeps(enclave)),
  };
  return createBridge(deps);
}

function chatRequest(init: { headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`${LOCAL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Host: '127.0.0.1:4141',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    body: init.body ?? JSON.stringify(CHAT_BODY),
  });
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${LOCAL}${path}`, { headers: { Host: '127.0.0.1:4141', ...headers } });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe('the bridge', () => {
  it('seals a plain chat to the verified enclave, and answers it in the clear', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('Hi there.'))]);
    const response = await bridgeOn(enclave)(
      chatRequest({ headers: { 'Postman-Token': 'abc', 'User-Agent': 'PostmanRuntime/7' } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const answer = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(answer.choices[0]?.message.content).toBe('Hi there.');
    const [opened] = enclave.opened;
    expect(opened?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(opened?.headers.get('X-Tinfoil-Model')).toBe('gpt-oss-120b');
    expect(opened?.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(opened?.plaintext ?? '{}')).toMatchObject(CHAT_BODY);
  });

  it('passes a chat of ZDR on as plain JSON, and verifies nothing', async () => {
    const enclave = await TestEnclave.create([]);
    const { fetch, seen } = recordingFetch([() => jsonResponse(chatCompletion('Hi there.'))]);
    const body = { model: 'zdr/claude-sonnet-5.5', messages: CHAT_BODY.messages };
    const handler = createBridge({
      baseUrl: BASE_URL,
      send: fetch,
      steps: stepsOn(enclave),
      chatFetch: (apiKey) =>
        buildFetch(
          { apiKey, baseURL: BASE_URL, fetch },
          {
            ...clientDeps(enclave),
            verify: () => Promise.reject(new Error('A plain chat verifies nothing.')),
          },
        ),
    });

    const response = await handler(chatRequest({ body: JSON.stringify(body) }));

    expect(response.status).toBe(200);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual(body);
    expect(seen[0]?.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]?.headers.get('X-Tinfoil-Model')).toBeNull();
  });

  it('sends nothing else that describes the machine of the caller', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('ok'))]);
    await bridgeOn(enclave)(
      chatRequest({ headers: { 'Postman-Token': 'abc', 'User-Agent': 'PostmanRuntime/7' } }),
    );
    const headers = enclave.opened[0]?.headers;
    expect(headers?.get('Postman-Token')).toBeNull();
    expect(headers?.get('User-Agent') ?? '').not.toContain('Postman');
  });

  it('streams a chat as the enclave sends it', async () => {
    const enclave = await TestEnclave.create([
      () => ({
        status: 200,
        contentType: 'text/event-stream',
        frames: chatStreamEvents(['Private ', 'by ', 'default.']),
      }),
    ]);
    const response = await bridgeOn(enclave)(
      chatRequest({ body: JSON.stringify({ ...CHAT_BODY, stream: true }) }),
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Private ');
    expect(text).toContain('default.');
  });

  it('passes on an answer of the API as it is, such as a key with too little credit', async () => {
    const low = { error: { code: 'balance_low', message: 'Too little.' } };
    const enclave = await TestEnclave.create([() => ({ plain: jsonResponse(low, 402) })]);
    const response = await bridgeOn(enclave)(chatRequest());
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual(low);
  });

  it.each(['/v1/models', '/v1/attestation', '/v1/balance'])(
    'passes GET %s to the API with no seal',
    async (path) => {
      const enclave = await TestEnclave.create([]);
      const send = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
      const response = await bridgeOn(
        enclave,
        send,
      )(getRequest(path, { Authorization: `Bearer ${API_KEY}`, 'Postman-Token': 'abc' }));
      expect(response.status).toBe(200);
      const [url, init] = send.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE_URL}${path.slice('/v1'.length)}`);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
      expect(headers.get('Postman-Token')).toBeNull();
    },
  );

  it('sends nothing for a chat without a key of the right shape', async () => {
    const enclave = await TestEnclave.create([]);
    for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer sk-test' }]) {
      const response = await bridgeOn(enclave)(chatRequest({ headers }));
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe('invalid_api_key');
    }
    expect(enclave.opened).toHaveLength(0);
  });

  it('takes the name of the scheme in any case', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('ok'))]);
    const response = await bridgeOn(enclave)(
      chatRequest({ headers: { Authorization: `bearer ${API_KEY}` } }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ['not JSON', 'hello'],
    ['no model', '{"messages":[]}'],
  ])('sends nothing for a body with %s', async (_name, body) => {
    const enclave = await TestEnclave.create([]);
    const response = await bridgeOn(enclave)(chatRequest({ body }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(enclave.opened).toHaveLength(0);
  });

  it('sends nothing for a chat with no body', async () => {
    const enclave = await TestEnclave.create([]);
    const send = vi.fn<typeof fetch>();
    const response = await bridgeOn(
      enclave,
      send,
    )(
      new Request(`${LOCAL}/v1/chat/completions`, {
        method: 'POST',
        headers: { Host: '127.0.0.1:4141', Authorization: `Bearer ${API_KEY}` },
      }),
    );
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the enclave fails its verification, and names the step', async () => {
    const enclave = await TestEnclave.create([]);
    const response = await createBridge({
      baseUrl: BASE_URL,
      send: enclave.fetch,
      steps: stepsOn(enclave),
      chatFetch: (apiKey) =>
        buildFetch(
          { apiKey, baseURL: BASE_URL, fetch: enclave.fetch },
          {
            ...clientDeps(enclave),
            verify: () => Promise.reject(new VerificationError('measurement', 'No match.')),
          },
        ),
    })(chatRequest());
    expect(response.status).toBe(502);
    const error = await errorOf(response);
    expect(error.code).toBe('verification_failed');
    expect(error.message).toContain('measurement');
    expect(enclave.opened).toHaveLength(0);
  });

  it('answers 502 when the API cannot be reached', async () => {
    const enclave = await TestEnclave.create([]);
    const send = vi.fn<typeof fetch>(() => Promise.reject(new Error('Offline.')));
    const response = await bridgeOn(enclave, send)(getRequest('/v1/models'));
    expect(response.status).toBe(502);
    expect((await errorOf(response)).code).toBe('api_unreachable');
  });

  it('refuses a web page, by its origin or by a host name that points here', async () => {
    const enclave = await TestEnclave.create([]);
    const handler = bridgeOn(enclave);
    const fromPage = await handler(chatRequest({ headers: { Origin: 'https://evil.example' } }));
    expect(fromPage.status).toBe(403);
    const rebound = await handler(chatRequest({ headers: { Host: 'evil.example:4141' } }));
    expect(rebound.status).toBe(403);
    expect(enclave.opened).toHaveLength(0);
  });

  it('takes both names of this machine', async () => {
    const answer = (): EnclaveAnswer => sealedJson(chatCompletion('ok'));
    const enclave = await TestEnclave.create([answer]);
    const response = await bridgeOn(enclave)(chatRequest({ headers: { Host: 'localhost:4141' } }));
    expect(response.status).toBe(200);
  });

  it.each([
    ['GET', '/v1/keys'],
    ['POST', '/v1/keys/fill'],
    ['POST', '/v1/keys/close'],
    ['DELETE', '/v1/chat/completions'],
  ])('has no route %s %s, and sends nothing', async (method, path) => {
    const enclave = await TestEnclave.create([]);
    const send = vi.fn<typeof fetch>();
    const response = await bridgeOn(
      enclave,
      send,
    )(
      new Request(`${LOCAL}${path}`, {
        method,
        headers: { Host: '127.0.0.1:4141' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
    );
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(enclave.opened).toHaveLength(0);
  });
});

describe('a chat in steps', () => {
  function encryptRequest(body: string = JSON.stringify(CHAT_BODY), key = API_KEY): Request {
    return new Request(`${LOCAL}/v1/encrypt`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:4141', Authorization: `Bearer ${key}` },
      body,
    });
  }

  function decryptRequest(body: unknown): Request {
    return new Request(`${LOCAL}/v1/decrypt`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:4141' },
      body: JSON.stringify(body),
    });
  }

  /** Sends what the first step made to the enclave as text, as Postman does with the proxy. */
  async function sendToEnclave(
    enclave: TestEnclave,
    chat: EncryptedChat,
  ): Promise<{ nonce: string; ciphertext: string }> {
    const answer = await enclave.fetch(chat.url, {
      method: 'POST',
      headers: chat.headers,
      body: Buffer.from(chat.body, 'base64url'),
    });
    return {
      nonce: answer.headers.get('Ehbp-Response-Nonce') ?? '',
      ciphertext: Buffer.from(await answer.arrayBuffer()).toString('base64url'),
    };
  }

  it('encrypts here, lets another tool send it, and decrypts the answer here', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('Hi there.'))]);
    const handler = bridgeOn(enclave);

    const first = await handler(encryptRequest());
    expect(first.status).toBe(200);
    const chat = (await first.json()) as EncryptedChat;
    expect(chat.url).toBe(`${BASE_URL}/chat/completions`);
    expect(chat.headers['X-Tinfoil-Model']).toBe('gpt-oss-120b');
    expect(chat.headers['X-Tinfoil-Enclave-Url']).toBe('https://enclave.example');
    expect(chat.headers['X-Thinkr-Body-Encoding']).toBe('base64url');
    expect(chat.headers['Ehbp-Encapsulated-Key']).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(chat.body, 'base64url').toString()).not.toContain('Hello');

    const answer = await sendToEnclave(enclave, chat);
    const plain = JSON.parse(enclave.opened[0]?.plaintext ?? '{}') as Record<string, unknown>;
    expect(plain).toMatchObject(CHAT_BODY);
    expect(plain.user_cache_secret).toMatch(/^[0-9a-f]{64}$/);

    const last = await handler(decryptRequest({ id: chat.id, ...answer }));
    expect(last.status).toBe(200);
    expect(last.headers.get('content-type')).toBe('application/json');
    const opened = (await last.json()) as { choices: { message: { content: string } }[] };
    expect(opened.choices[0]?.message.content).toBe('Hi there.');
  });

  it('opens each answer once, and never with the id of another chat', async () => {
    const answer = (): EnclaveAnswer => sealedJson(chatCompletion('ok'));
    const enclave = await TestEnclave.create([answer, answer]);
    const handler = bridgeOn(enclave);
    const one = (await (await handler(encryptRequest())).json()) as EncryptedChat;
    const two = (await (await handler(encryptRequest())).json()) as EncryptedChat;
    const answerOne = await sendToEnclave(enclave, one);

    const crossed = await handler(decryptRequest({ id: two.id, ...answerOne }));
    expect(crossed.status).toBe(400);
    expect(((await crossed.json()) as { error: { code: string } }).error.code).toBe(
      'encryption_failed',
    );

    expect((await handler(decryptRequest({ id: one.id, ...answerOne }))).status).toBe(200);
    const again = await handler(decryptRequest({ id: one.id, ...answerOne }));
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    );
  });

  it('forgets the secrets of a chat once their time ends', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('ok'))]);
    let now = 0;
    const steps = stepsOn(enclave, () => now);
    const chat = await steps.encrypt(API_KEY, new TextEncoder().encode(JSON.stringify(CHAT_BODY)));
    const answer = await sendToEnclave(enclave, chat);
    now = 10 * 60 * 1000;
    await expect(steps.decrypt(chat.id, answer.nonce, answer.ciphertext)).rejects.toThrow(
      'Encrypt the chat again.',
    );
  });

  it('keeps a fixed number of chats, and drops the oldest', async () => {
    const enclave = await TestEnclave.create([]);
    const steps = stepsOn(enclave);
    const body = new TextEncoder().encode(JSON.stringify(CHAT_BODY));
    const first = await steps.encrypt(API_KEY, body);
    for (let count = 0; count < 64; count += 1) await steps.encrypt(API_KEY, body);
    await expect(steps.decrypt(first.id, 'ab'.repeat(32), 'AAAA')).rejects.toThrow(
      'Encrypt the chat again.',
    );
  });

  it.each([
    ['a stream', JSON.stringify({ ...CHAT_BODY, stream: true }), 'has no stream'],
    ['no model', '{"messages":[]}', 'must name its model'],
    ['no JSON', 'hello', 'must be JSON'],
    ['a model of ZDR', JSON.stringify({ ...CHAT_BODY, model: 'zdr/x' }), 'takes plain JSON'],
    ['a model of Open', JSON.stringify({ ...CHAT_BODY, model: 'open/x' }), 'takes plain JSON'],
  ])('encrypts nothing for %s', async (_name, body, message) => {
    const enclave = await TestEnclave.create([]);
    const response = await bridgeOn(enclave)(encryptRequest(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      message,
    );
  });

  it('encrypts nothing without a key of the right shape', async () => {
    const enclave = await TestEnclave.create([]);
    const response = await bridgeOn(enclave)(encryptRequest(undefined, 'sk-test'));
    expect(response.status).toBe(401);
  });

  it.each([
    ['no fields', {}],
    ['an unknown id', { id: 'none', nonce: 'ab'.repeat(32), ciphertext: 'AAAA' }],
    ['a nonce of another type', { id: 'none', nonce: 1, ciphertext: 'AAAA' }],
  ])('refuses to decrypt with %s', async (_name, body) => {
    const enclave = await TestEnclave.create([]);
    const response = await bridgeOn(enclave)(decryptRequest(body));
    expect(response.status).toBe(400);
  });

  it('refuses a ciphertext that is not base64url, and a nonce of another shape', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('ok'))]);
    const handler = bridgeOn(enclave);
    const chat = (await (await handler(encryptRequest())).json()) as EncryptedChat;
    const answer = await sendToEnclave(enclave, chat);
    const badText = await handler(decryptRequest({ ...answer, id: chat.id, ciphertext: 'a b!' }));
    expect(badText.status).toBe(400);
    const badNonce = await handler(decryptRequest({ ...answer, id: chat.id, nonce: 'abcd' }));
    expect(badNonce.status).toBe(400);
  });

  it('refuses a web page at each step', async () => {
    const enclave = await TestEnclave.create([]);
    const handler = bridgeOn(enclave);
    for (const path of ['/v1/encrypt', '/v1/decrypt']) {
      const response = await handler(
        new Request(`${LOCAL}${path}`, {
          method: 'POST',
          headers: { Host: '127.0.0.1:4141', Origin: 'https://evil.example' },
          body: '{}',
        }),
      );
      expect(response.status).toBe(403);
    }
  });
});

describe('the server of the bridge', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const running = server;
    server = null;
    if (running !== null) await new Promise((done) => running.close(done));
  });

  async function serving(
    handler: BridgeHandler,
    options: { maxBodyBytes?: number; onAnswer?: (line: string) => void } = {},
  ): Promise<string> {
    server = await startBridgeServer(handler, { port: 0, ...options });
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');
    return `http://127.0.0.1:${String(port)}`;
  }

  it('hands a request over whole, with the host that the caller named', async () => {
    const seen: { method: string; host: string | null; body: string }[] = [];
    const url = await serving(async (request) => {
      seen.push({
        method: request.method,
        host: request.headers.get('host'),
        body: await request.text(),
      });
      return Response.json({ ok: true }, { status: 201 });
    });
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: 'hello',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.host).toBe(new URL(url).host);
    expect(seen[0]?.body).toBe('hello');
  });

  it('streams an answer as it arrives', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const encoder = new TextEncoder();
    const url = await serving(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode('first'));
              await held;
              controller.enqueue(encoder.encode('second'));
              controller.close();
            },
          }),
        ),
      ),
    );
    const response = await fetch(`${url}/v1/models`);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe('first');
    release();
    const second = await reader?.read();
    expect(new TextDecoder().decode(second?.value)).toBe('second');
  });

  it('refuses a body over the limit before the bridge sees it', async () => {
    const handler = vi.fn<BridgeHandler>();
    const url = await serving(handler, { maxBodyBytes: 4 });
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: 'too long',
    });
    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tells the method, the path, and the status, and never a query or a body', async () => {
    const lines: string[] = [];
    const url = await serving(() => Promise.resolve(new Response('ok')), {
      onAnswer: (line) => lines.push(line),
    });
    const response = await fetch(`${url}/v1/models?secret=abc`);
    await response.text();
    await vi.waitFor(() => {
      expect(lines).toEqual(['GET /v1/models 200']);
    });
  });
});
