import type { Verification } from '@thinkr/verifier';
import { API } from './config/api.js';
import { KEY_CONFIG_PROBLEM } from './config/ehbp.js';
import { ThinkrError } from './errors.js';
import { isRecord } from './lib/json.js';
import type { EnclaveSession } from './session.js';

export interface ClientFetchDeps {
  /** The base URL that `checkBaseUrl` returned. */
  readonly baseUrl: string;
  readonly session: EnclaveSession;
  /** A fetch that seals each body to a verified enclave and opens its answer. */
  readonly seal: (verification: Verification) => Promise<typeof fetch>;
  /** Sends a request with no body, which goes out as it is. */
  readonly send: typeof fetch;
}

/**
 * The fetch of the OpenAI client. A request with a body goes sealed to the verified enclave, with
 * the model of its body in the model header; a request with no body, such as the list of models,
 * goes as it is. Either goes only to the origin of the base URL, since it carries the API key.
 */
export function createClientFetch(deps: ClientFetchDeps): typeof fetch {
  const origin = new URL(deps.baseUrl).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.origin !== origin) {
      throw new ThinkrError('invalid_request', `Refusing to send to ${target.origin}.`);
    }
    const headers = keptHeaders(request.headers);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length === 0) {
      return deps.send(target.href, { method: request.method, headers, signal: request.signal });
    }
    headers.set(API.modelHeader, modelOf(body));
    const sendSealed = async (verification: Verification): Promise<Response> => {
      const sealedFetch = await deps.seal(verification);
      return sealedFetch(target.href, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      });
    };
    const first = await sendSealed(await deps.session.current());
    if (!(await isKeyConfigProblem(first))) return first;
    await first.body?.cancel();
    return sendSealed(await deps.session.renew());
  };
}

/** The headers of a request, less those that describe the machine of the caller. */
function keptHeaders(headers: Headers): Headers {
  const kept = new Headers();
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith(API.droppedHeaderPrefix)) kept.set(name, value);
  });
  return kept;
}

/** The model that a JSON body names. Throws for a body that is not JSON or names no model. */
export function modelOf(body: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new ThinkrError('invalid_request', 'A request body must be JSON.', { cause: error });
  }
  const model = isRecord(parsed) ? parsed[API.modelField] : undefined;
  if (typeof model !== 'string' || model === '') {
    throw new ThinkrError('invalid_request', 'A request body must name its model.');
  }
  return model;
}

/**
 * True when the enclave answered that the request was sealed to a key it no longer holds. It reads
 * a copy of the body, so any other answer passes on whole.
 */
async function isKeyConfigProblem(response: Response): Promise<boolean> {
  if (response.status !== KEY_CONFIG_PROBLEM.status) return false;
  if (mediaTypeOf(response.headers) !== KEY_CONFIG_PROBLEM.mediaType) return false;
  const text = await readAtMost(response.clone(), KEY_CONFIG_PROBLEM.maxBytes);
  return text !== null && problemTypeOf(text) === KEY_CONFIG_PROBLEM.type;
}

function mediaTypeOf(headers: Headers): string | undefined {
  return headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
}

/** The body as text, or null when it is longer than `maxBytes`. */
async function readAtMost(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** The `type` of a problem body, or null for a body that is not a JSON problem. */
function problemTypeOf(text: string): string | null {
  let problem: unknown;
  try {
    problem = JSON.parse(text);
  } catch {
    // A problem body that is not JSON is some other error, which the caller reads as it is.
    return null;
  }
  return isRecord(problem) && typeof problem.type === 'string' ? problem.type : null;
}
