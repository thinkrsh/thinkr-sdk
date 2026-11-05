import { createSealedFetch, VerificationError, type SealedFetchOptions } from '@thinkr/verifier';
import { APIConnectionError } from 'openai';
import { describe, expect, it } from 'vitest';
import { buildClient, createClient, type ClientDeps } from '../src/client.js';
import { ThinkrError } from '../src/errors.js';
import {
  API_KEY,
  BASE_URL,
  chatCompletion,
  chatStreamEvents,
  fakeVerification,
  jsonResponse,
  keyConfigProblem,
  manualClock,
  recordingFetch,
} from './fakes.js';
import { TestEnclave, type EnclaveAnswer } from './testEnclave.js';

const MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

/** An answer of the enclave in one JSON body, as a chat that does not stream gets it. */
function sealedJson(body: unknown): EnclaveAnswer {
  return { status: 200, contentType: 'application/json', frames: [JSON.stringify(body)] };
}

/** Dependencies with the real seal of `@thinkr/verifier`, pointed at a test enclave. */
function depsFor(
  enclave: TestEnclave,
  verifyCalls: { count: number },
): ClientDeps & { sealed: SealedFetchOptions[] } {
  const sealed: SealedFetchOptions[] = [];
  return {
    sealed,
    verify: () => {
      verifyCalls.count += 1;
      return Promise.resolve(
        fakeVerification({
          hardware: { ...fakeVerification().hardware, hpkePublicKey: enclave.publicKeyHex },
        }),
      );
    },
    seal: (options) => {
      sealed.push(options);
      return createSealedFetch(options);
    },
    now: manualClock().now,
  };
}

describe('createClient', () => {
  it('stops on a missing or malformed key before it builds a client', () => {
    expect(() => createClient({ apiKey: undefined })).toThrow(ThinkrError);
    expect(() => createClient({ apiKey: 'sk-test' })).toThrow(ThinkrError);
    expect(() => createClient({ apiKey: API_KEY, baseURL: 'http://api.example/v1' })).toThrow(
      ThinkrError,
    );
  });

  it('seals a chat to the verified enclave and reads its answer', async () => {
    const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('Hi there.'))]);
    const verifyCalls = { count: 0 };
    const deps = depsFor(enclave, verifyCalls);
    const ai = buildClient({ apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch }, deps);

    const completion = await ai.chat.completions.create({
      model: 'gpt-oss-120b',
      messages: MESSAGES,
    });

    expect(completion.choices[0]?.message.content).toBe('Hi there.');
    const [opened] = enclave.opened;
    expect(opened?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(opened?.headers.get('X-Tinfoil-Model')).toBe('gpt-oss-120b');
    expect(opened?.headers.get('X-Tinfoil-Enclave-Url')).toBe('https://enclave.example/');
    expect(opened?.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
    expect(
      [...(opened?.headers.keys() ?? [])].some((name) => name.startsWith('x-stainless-')),
    ).toBe(false);
    const body = JSON.parse(opened?.plaintext ?? '{}') as Record<string, unknown>;
    expect(body.model).toBe('gpt-oss-120b');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.user_cache_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.sealed[0]?.baseUrl).toBe(BASE_URL);
    expect(verifyCalls.count).toBe(1);
  });

  it.each(['zdr/claude-sonnet-5.5', 'open/grok-4.5'])(
    'sends a chat of %s as plain JSON, with no verification',
    async (model) => {
      const { fetch, seen } = recordingFetch([() => jsonResponse(chatCompletion('Hi there.'))]);
      const verifyCalls = { count: 0 };
      const deps: ClientDeps = {
        verify: () => {
          verifyCalls.count += 1;
          return Promise.reject(new Error('A plain chat verifies nothing.'));
        },
        seal: () => {
          throw new Error('A plain chat seals nothing.');
        },
        now: manualClock().now,
      };
      const ai = buildClient({ apiKey: API_KEY, baseURL: BASE_URL, fetch }, deps);

      const completion = await ai.chat.completions.create({ model, messages: MESSAGES });

      expect(completion.choices[0]?.message.content).toBe('Hi there.');
      expect(verifyCalls.count).toBe(0);
      const [sent] = seen;
      expect(sent?.url).toBe(`${BASE_URL}/chat/completions`);
      expect(sent?.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
      expect(sent?.headers.get('X-Tinfoil-Model')).toBeNull();
      expect(
        [...(sent?.headers.keys() ?? [])].some((name) => name.startsWith('x-stainless-')),
      ).toBe(false);
      expect(JSON.parse(sent?.body ?? '{}')).toEqual({ model, messages: MESSAGES });
    },
  );

  it.each(['gpt-oss-120b', 'zdr', 'zdr-private/model', 'OPEN/model', 'private/zdr/model'])(
    'keeps the id %j encrypted, since only the two prefixes go plain',
    async (model) => {
      const enclave = await TestEnclave.create([() => sealedJson(chatCompletion('Hi.'))]);
      const deps = depsFor(enclave, { count: 0 });
      const ai = buildClient({ apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch }, deps);

      await ai.chat.completions.create({ model, messages: MESSAGES });

      expect(enclave.opened[0]?.headers.get('X-Tinfoil-Model')).toBe(model);
    },
  );

  it('streams a chat as the enclave sends it', async () => {
    const enclave = await TestEnclave.create([
      () => ({
        status: 200,
        contentType: 'text/event-stream',
        frames: chatStreamEvents(['Private ', 'by ', 'default.']),
      }),
    ]);
    const ai = buildClient(
      { apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch },
      depsFor(enclave, { count: 0 }),
    );

    const stream = await ai.chat.completions.create({
      model: 'gpt-oss-120b',
      messages: MESSAGES,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';

    expect(text).toBe('Private by default.');
    expect(JSON.parse(enclave.opened[0]?.plaintext ?? '{}')).toMatchObject({ stream: true });
  });

  it('verifies once for many chats, and the cache secret stays the same', async () => {
    const answer = (): EnclaveAnswer => sealedJson(chatCompletion('ok'));
    const enclave = await TestEnclave.create([answer, answer]);
    const verifyCalls = { count: 0 };
    const ai = buildClient(
      { apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch },
      depsFor(enclave, verifyCalls),
    );
    await ai.chat.completions.create({ model: 'gpt-oss-120b', messages: MESSAGES });
    await ai.chat.completions.create({ model: 'gpt-oss-120b', messages: MESSAGES });
    const secrets = enclave.opened.map(
      (request) => (JSON.parse(request.plaintext) as Record<string, unknown>).user_cache_secret,
    );
    expect(verifyCalls.count).toBe(1);
    expect(secrets[0]).toBe(secrets[1]);
  });

  it('verifies again and sends once more when the enclave changed its key', async () => {
    const enclave = await TestEnclave.create([
      () => ({ plain: keyConfigProblem() }),
      () => sealedJson(chatCompletion('After the new key.')),
    ]);
    const verifyCalls = { count: 0 };
    const ai = buildClient(
      { apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch },
      depsFor(enclave, verifyCalls),
    );
    const completion = await ai.chat.completions.create({
      model: 'gpt-oss-120b',
      messages: MESSAGES,
    });
    expect(completion.choices[0]?.message.content).toBe('After the new key.');
    expect(verifyCalls.count).toBe(2);
    expect(enclave.opened).toHaveLength(2);
  });

  it('lists the models with no seal and no verification', async () => {
    const list = {
      object: 'list',
      data: [
        {
          id: 'gpt-oss-120b',
          object: 'model',
          owned_by: 'OpenAI',
          name: 'GPT-OSS 120B',
          context_length: 131_072,
          pricing: { input_usd_per_mtok: 0.09, output_usd_per_mtok: 0.48 },
          vision: false,
          reasoning: true,
        },
      ],
    };
    const seen: string[] = [];
    const send = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      seen.push(request.url);
      expect(request.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
      return Promise.resolve(jsonResponse(list));
    };
    const verifyCalls = { count: 0 };
    const enclave = await TestEnclave.create([]);
    const ai = buildClient(
      { apiKey: API_KEY, baseURL: BASE_URL, fetch: send },
      depsFor(enclave, verifyCalls),
    );
    const ids: string[] = [];
    for await (const model of ai.models.list()) ids.push(model.id);
    expect(ids).toEqual(['gpt-oss-120b']);
    expect(seen).toEqual([`${BASE_URL}/models`]);
    expect(verifyCalls.count).toBe(0);
  });

  it('reads the credit left on the key with no seal and no verification', async () => {
    const seen: string[] = [];
    const send = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${request.url}`);
      expect(request.headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
      return Promise.resolve(jsonResponse({ usd: 1.2 }));
    };
    const verifyCalls = { count: 0 };
    const ai = buildClient(
      { apiKey: API_KEY, baseURL: BASE_URL, fetch: send },
      depsFor(await TestEnclave.create([]), verifyCalls),
    );
    expect(await ai.get<{ usd: number }>('/balance')).toEqual({ usd: 1.2 });
    expect(seen).toEqual([`GET ${BASE_URL}/balance`]);
    expect(verifyCalls.count).toBe(0);
  });

  it('sends nothing when the verification fails, and names the step in the cause', async () => {
    const enclave = await TestEnclave.create([]);
    const deps: ClientDeps = {
      verify: () => Promise.reject(new VerificationError('measurement', 'Another release runs.')),
      seal: createSealedFetch,
      now: manualClock().now,
    };
    const ai = buildClient({ apiKey: API_KEY, baseURL: BASE_URL, fetch: enclave.fetch }, deps);
    const error: unknown = await ai.chat.completions
      .create({ model: 'gpt-oss-120b', messages: MESSAGES }, { maxRetries: 0 })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(APIConnectionError);
    const cause = (error as APIConnectionError).cause;
    expect(cause).toBeInstanceOf(VerificationError);
    expect((cause as VerificationError).step).toBe('measurement');
    expect(enclave.opened).toHaveLength(0);
    expect(enclave.plainRequests).toHaveLength(0);
  });
});
