/**
 * The local bridge, `npx @thinkr/sdk serve`: a server on the machine of the developer, for callers
 * that cannot encrypt, such as Postman and curl. It encrypts each chat there, never at the proxy or
 * at Cloudflare, so the text never leaves this machine in the clear.
 */
export const BRIDGE = {
  /** The loopback only, so no other machine can reach it. */
  host: '127.0.0.1',
  defaultPort: 4141,
  /** The names of this machine that a request may call the bridge by. */
  localHostnames: ['127.0.0.1', 'localhost'],
  /** Where a caller sends a chat, as in the OpenAI API. */
  chatPath: '/v1/chat/completions',
  /**
   * The three steps for a tool that sends the ciphertext itself: encrypt here, send to the API,
   * decrypt here.
   */
  encryptPath: '/v1/encrypt',
  decryptPath: '/v1/decrypt',
  /** How long the secrets of an encrypted chat wait for its answer, in memory only: 10 minutes. */
  stepTtlMs: 10 * 60 * 1000,
  /** The encrypted chats that wait at once; a new one past this drops the oldest. */
  maxStepsKept: 64,
  /** The routes with no body, which go to the API as they are. */
  readPaths: ['/v1/models', '/v1/attestation', '/v1/balance'],
  /** What a path of the bridge starts with and the base URL of the API already holds. */
  pathPrefix: '/v1',
  /** The only headers of a caller that go on, so that nothing else describes its machine. */
  passedHeaders: ['authorization', 'content-type', 'accept'],
  /** The most that one chat body takes: the limit of a sealed chat at the proxy, 16 MiB. */
  maxBodyBytes: 16 * 1024 * 1024,
  /** The API keys that keep a verified session at once, in memory only. */
  maxKeysKept: 32,
  authScheme: 'bearer',
} as const;
