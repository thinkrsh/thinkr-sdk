import { randomUUID } from 'node:crypto';
import { EhbpError, VerificationError } from '@thinkr/verifier';
import { buildFetch } from './client.js';
import { BRIDGE } from './config/bridge.js';
import { verifyRouter } from './enclave.js';
import { ThinkrError, type ThinkrErrorCode } from './errors.js';
import { isRecord } from './lib/json.js';
import { createChatSteps, type ChatSteps } from './steps.js';

/** What the bridge is built on. The tests put fakes in their place. */
export interface BridgeDeps {
  /** The base URL that `checkBaseUrl` returned. */
  readonly baseUrl: string;
  /** The fetch that verifies the enclave and seals a chat, for one API key. */
  readonly chatFetch: (apiKey: string) => typeof fetch;
  /** Sends a request with no body, which goes out as it is. */
  readonly send: typeof fetch;
  /** A chat in steps, for a tool that sends the ciphertext to the API itself. */
  readonly steps: ChatSteps;
}

export type BridgeHandler = (request: Request) => Promise<Response>;

const HTTP_OK = { unauthorized: 401, badRequest: 400, forbidden: 403, notFound: 404 } as const;
const HTTP_BAD_GATEWAY = 502;

const STATUS_OF_SDK_ERROR: Readonly<Record<ThinkrErrorCode, number>> = {
  invalid_api_key: HTTP_OK.unauthorized,
  invalid_base_url: HTTP_OK.badRequest,
  invalid_request: HTTP_OK.badRequest,
  attestation_unavailable: HTTP_BAD_GATEWAY,
};

/**
 * The bridge as a function from a plain request to a plain answer. A chat goes out sealed to the
 * verified enclave, and its answer comes back opened and streaming. Each error has the shape of an
 * error of the API, and an error that stops a chat means that nothing left this machine.
 */
export function createBridge(deps: BridgeDeps): BridgeHandler {
  return async (request) => {
    try {
      return await route(deps, request);
    } catch (error) {
      return answerOfError(error);
    }
  };
}

/** The bridge on the live API: one verified session for each API key that calls it. */
export function liveBridgeDeps(baseUrl: string): BridgeDeps {
  const fetches = new Map<string, typeof fetch>();
  const send = globalThis.fetch.bind(globalThis);
  return {
    baseUrl,
    send,
    steps: createChatSteps({
      baseUrl,
      verify: () => verifyRouter(baseUrl, send),
      now: () => Date.now(),
      newId: randomUUID,
    }),
    chatFetch: (apiKey) => {
      const kept = fetches.get(apiKey);
      if (kept !== undefined) return kept;
      if (fetches.size >= BRIDGE.maxKeysKept) fetches.clear();
      const made = buildFetch({ apiKey, baseURL: baseUrl });
      fetches.set(apiKey, made);
      return made;
    },
  };
}

async function route(deps: BridgeDeps, request: Request): Promise<Response> {
  if (!isFromThisMachine(request.headers)) {
    return problem(
      HTTP_OK.forbidden,
      'not_local',
      'This bridge takes requests of programs on this machine, never of a web page.',
    );
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const target = `${deps.baseUrl}${path.slice(BRIDGE.pathPrefix.length)}${url.search}`;
  const headers = passedHeaders(request.headers);
  if (request.method === 'GET' && isReadPath(path)) {
    return passedOn(await deps.send(target, { headers, signal: request.signal }));
  }
  if (request.method === 'POST' && path === BRIDGE.chatPath) {
    const body = await bodyOf(request);
    const sealed = deps.chatFetch(bearerOf(request.headers));
    return passedOn(
      await sealed(target, { method: 'POST', headers, body, signal: request.signal }),
    );
  }
  if (request.method === 'POST' && path === BRIDGE.encryptPath) {
    const encrypted = await deps.steps.encrypt(bearerOf(request.headers), await bodyOf(request));
    return Response.json(encrypted);
  }
  if (request.method === 'POST' && path === BRIDGE.decryptPath) {
    const { id, nonce, ciphertext } = decryptFieldsOf(await bodyOf(request));
    const opened = await deps.steps.decrypt(id, nonce, ciphertext);
    return new Response(new Uint8Array(opened), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return problem(HTTP_OK.notFound, 'not_found', `This bridge has no route ${path}.`);
}

async function bodyOf(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) throw new ThinkrError('invalid_request', 'A request body must be JSON.');
  return body;
}

/** The three fields that the step of decrypting takes, or an error that names them. */
function decryptFieldsOf(body: Uint8Array): { id: string; nonce: string; ciphertext: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new ThinkrError('invalid_request', 'A request body must be JSON.', { cause: error });
  }
  if (isRecord(parsed)) {
    const { id, nonce, ciphertext } = parsed;
    if (typeof id === 'string' && typeof nonce === 'string' && typeof ciphertext === 'string') {
      return { id, nonce, ciphertext };
    }
  }
  throw new ThinkrError('invalid_request', 'Send the id, the nonce, and the ciphertext.');
}

/**
 * True for a program on this machine. A web page names its origin, and a page that points its own
 * host name at this machine names that host, so neither gets through.
 */
function isFromThisMachine(headers: Headers): boolean {
  if (headers.has('origin')) return false;
  const hostname = headers.get('host')?.split(':')[0];
  return BRIDGE.localHostnames.some((name) => name === hostname);
}

function isReadPath(path: string): boolean {
  return BRIDGE.readPaths.some((readPath) => readPath === path);
}

function passedHeaders(headers: Headers): Headers {
  const passed = new Headers();
  for (const name of BRIDGE.passedHeaders) {
    const value = headers.get(name);
    if (value !== null) passed.set(name, value);
  }
  return passed;
}

/** The token of an Authorization header of the Bearer scheme, whose name takes any case. */
function bearerOf(headers: Headers): string {
  const header = headers.get('authorization') ?? '';
  const scheme = `${BRIDGE.authScheme} `;
  return header.toLowerCase().startsWith(scheme) ? header.slice(scheme.length).trim() : '';
}

/** The status, the type, and the body of an answer of the API, and nothing else of it. */
function passedOn(response: Response): Response {
  const contentType = response.headers.get('content-type');
  return new Response(response.body, {
    status: response.status,
    headers: contentType === null ? {} : { 'content-type': contentType },
  });
}

function answerOfError(error: unknown): Response {
  if (error instanceof ThinkrError) {
    return problem(STATUS_OF_SDK_ERROR[error.code], error.code, error.message);
  }
  if (error instanceof VerificationError) {
    return problem(
      HTTP_BAD_GATEWAY,
      'verification_failed',
      `The enclave failed its verification at the step ${error.step}, so nothing was sent.`,
    );
  }
  if (error instanceof EhbpError) {
    return problem(HTTP_OK.badRequest, 'encryption_failed', error.message);
  }
  return problem(HTTP_BAD_GATEWAY, 'api_unreachable', 'The API could not be reached. Try again.');
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
