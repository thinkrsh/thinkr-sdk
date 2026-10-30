import type { Verification } from '@thinkr/verifier';
import type { EnclaveSession } from '../src/session.js';

/** An API key of the right shape, which no balance holds. */
export const API_KEY = `thkr_${'a'.repeat(43)}`;
export const BASE_URL = 'https://api.example/v1';

/** A verification that passed, as `verifyBundle` returns it, for an enclave of the tests. */
export function fakeVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    enclaveHost: 'enclave.example',
    repo: 'tinfoilsh/confidential-model-router',
    releaseTag: 'v0.0.1',
    releaseDigest: '00'.repeat(32),
    imageVersion: undefined,
    hardware: {
      product: 'Genoa',
      measurement: 'ab'.repeat(48),
      tlsKeyFingerprint: 'cd'.repeat(32),
      hpkePublicKey: 'ef'.repeat(32),
      reportedTcb: { bootloader: 1, tee: 1, snp: 1, microcode: 1 },
    },
    attestationHash: '12'.repeat(32),
    certificateNotAfter: new Date('2099-01-01T00:00:00Z'),
    verifiedAt: new Date('2026-10-29T00:00:00Z'),
    ...overrides,
  };
}

/** A session that always hands out one verification, and counts how often it was asked. */
export interface CountingSession extends EnclaveSession {
  readonly counts: { current: number; renew: number };
}

export function fixedSession(verification: Verification): CountingSession {
  const counts = { current: 0, renew: 0 };
  return {
    counts,
    current: () => {
      counts.current += 1;
      return Promise.resolve(verification);
    },
    renew: () => {
      counts.renew += 1;
      return Promise.resolve(verification);
    },
  };
}

/** One request as a fake fetch saw it. */
export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A fetch that records each request and answers with the next response of `answers`. */
export function recordingFetch(answers: (() => Response)[]): {
  fetch: typeof fetch;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const record = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
    const answer = answers[seen.length - 1];
    if (answer === undefined) throw new Error(`No answer for request ${String(seen.length)}.`);
    return answer();
  };
  return { fetch: record, seen };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The problem that an EHBP server sends for a request sealed to a key it no longer holds. */
export function keyConfigProblem(): Response {
  return new Response(
    JSON.stringify({ type: 'urn:ietf:params:ehbp:error:key-config', title: 'key changed' }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** A chat completion of the OpenAI API with one answer. */
export function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_761_696_000,
    model: 'gpt-oss-120b',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

/** The events of a streamed chat completion that answers with `parts`, then ends. */
export function chatStreamEvents(parts: readonly string[]): string[] {
  const chunks = parts.map((content) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1_761_696_000,
    model: 'gpt-oss-120b',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }));
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
}

/** A clock that only moves when a test moves it. */
export function manualClock(start = Date.parse('2026-10-29T00:00:00Z')): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}
