import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeHandler } from './bridge.js';
import { BRIDGE } from './config/bridge.js';

export interface BridgeServerOptions {
  readonly port: number;
  /** The most that one request body takes. */
  readonly maxBodyBytes?: number;
  /** Told the method, the path, and the status of each answer, and never a body or a header. */
  readonly onAnswer?: (line: string) => void;
}

const STATUS_TOO_LARGE = 413;
const STATUS_BAD_REQUEST = 400;

/** Serves the bridge on the loopback of this machine. Resolves once it listens. */
export async function startBridgeServer(
  handler: BridgeHandler,
  options: BridgeServerOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    void answer(handler, options, request, response);
  });
  server.listen(options.port, BRIDGE.host);
  await once(server, 'listening');
  return server;
}

async function answer(
  handler: BridgeHandler,
  options: BridgeServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) abort.abort();
  });
  try {
    const body = await readBody(request, options.maxBodyBytes ?? BRIDGE.maxBodyBytes);
    if (body === null) {
      writeProblem(response, STATUS_TOO_LARGE, 'The request body is too large.');
    } else {
      await writeAnswer(response, await handler(webRequest(request, body, abort.signal)), abort);
    }
  } catch (error) {
    // A caller that went away needs no answer, and any other failure here is a bad request.
    if (abort.signal.aborted) return;
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    writeProblem(response, STATUS_BAD_REQUEST, 'The request could not be read.');
  }
  options.onAnswer?.(`${request.method ?? ''} ${pathOf(request)} ${String(response.statusCode)}`);
}

/** The path of a request without its query, which a caller could put a secret in. */
function pathOf(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? '';
}

/** The whole body of a request, or null when it is longer than `maxBytes`. */
async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function webRequest(
  request: IncomingMessage,
  body: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // The host of the URL is fixed: the bridge reads the host that the caller named from its header.
  return new Request(`http://${BRIDGE.host}${request.url ?? '/'}`, {
    method,
    headers,
    signal,
    ...(hasBody ? { body } : {}),
  });
}

/** Writes an answer as it arrives, so that a streamed chat reads as the enclave sends it. */
async function writeAnswer(
  response: ServerResponse,
  answered: Response,
  abort: AbortController,
): Promise<void> {
  response.writeHead(answered.status, Object.fromEntries(answered.headers));
  if (answered.body !== null) {
    const reader = answered.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) await once(response, 'drain', { signal: abort.signal });
    }
  }
  response.end();
}

function writeProblem(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code: 'invalid_request', message } }));
}
