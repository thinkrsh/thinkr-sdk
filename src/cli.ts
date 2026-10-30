#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createBridge, liveBridgeDeps } from './bridge.js';
import { API } from './config/api.js';
import { BRIDGE } from './config/bridge.js';
import { verifyEnclave } from './enclave.js';
import { checkBaseUrl } from './options.js';
import { startBridgeServer } from './serve.js';

const HELP = `Usage: npx @thinkr/sdk serve [--port <port>]

Runs a local bridge to Thinkr Inference, for programs that cannot encrypt, such as Postman and curl.
Send a chat to the bridge as plain JSON, with your API key as a Bearer token. The bridge verifies
the enclave and encrypts the chat on this machine, so the text never leaves it in the clear.

Options:
  --port <port>      The port on 127.0.0.1. By default ${String(BRIDGE.defaultPort)}.
  --base-url <url>   The base URL of the API. By default ${API.defaultBaseUrl}.
  --help             Shows this text.
`;

const MAX_PORT = 65_535;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function portOf(text: string | undefined): number {
  if (text === undefined) return BRIDGE.defaultPort;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`The port must be a whole number from 1 to ${String(MAX_PORT)}.`);
  }
  return port;
}

async function serve(portText: string | undefined, baseUrlText: string | undefined): Promise<void> {
  const port = portOf(portText);
  const baseUrl = checkBaseUrl(baseUrlText ?? API.defaultBaseUrl);
  const verification = await verifyEnclave({ baseURL: baseUrl });
  say(`Enclave verified: ${verification.enclaveHost}, release ${verification.releaseTag}`);
  await startBridgeServer(createBridge(liveBridgeDeps(baseUrl)), { port, onAnswer: say });
  say(`Thinkr bridge: http://${BRIDGE.host}:${String(port)}${BRIDGE.pathPrefix}`);
  say('Chats are encrypted here, before they leave this machine. Press Ctrl+C to stop.');
}

/** The sentence for a failure at the start, with the port named when it is taken. */
function messageOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    return 'That port is in use. Name another with --port <port>.';
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help === true || positionals[0] !== 'serve') {
    say(HELP);
    if (values.help !== true) process.exitCode = 1;
    return;
  }
  await serve(values.port, values['base-url']);
}

main().catch((error: unknown) => {
  process.stderr.write(`${messageOf(error)}\n`);
  process.exitCode = 1;
});
