/**
 * The Inference API of Thinkr (decision 45; the owner, 29 Oct 2026): an OpenAI-compatible API for
 * the models of the private lane, which the credit on an API key pays. The paths and headers match
 * the Inference routes of the proxy of Thinkr.
 */
export const API = {
  /** Where the SDK sends by default. This host passes `/v1/*` on to the proxy of Thinkr. */
  defaultBaseUrl: 'https://api.thinkr.sh/v1',
  /**
   * Where a developer creates an API key and adds credit to it: the app since 30 Oct 2026, in place
   * of the dashboard.
   */
  keysPage: 'https://chat.thinkr.sh/keys',
  /** The attestation bundle of the router, under the base URL. */
  attestationPath: '/attestation',
  /**
   * The header that names the model of a sealed body. The proxy prices the request by it, and the
   * enclave refuses a body that names another model.
   */
  modelHeader: 'X-Tinfoil-Model',
  /** The field of a JSON body that names the model, as in the OpenAI API. */
  modelField: 'model',
  /** The path of a chat under the base URL. */
  chatPath: '/chat/completions',
  /**
   * The header and its value that send encrypted frames as text, for a tool that cannot send raw
   * bytes. Must match INFERENCE.bodyEncodingHeader and bodyEncoding in apps/proxy.
   */
  bodyEncodingHeader: 'X-Thinkr-Body-Encoding',
  bodyEncoding: 'base64url',
  /** The scheme of the verified enclave, which the proxy forwards each sealed request to. */
  enclaveScheme: 'https:',
  /**
   * Hosts where the base URL may use plain HTTP: the loopback of a laptop, where the proxy runs in
   * development. Anywhere else the API key would cross the network in the clear.
   */
  loopbackHosts: ['127.0.0.1', 'localhost', '[::1]'],
  /**
   * Headers of the OpenAI client that name the operating system, the processor, and the runtime of
   * the caller. The API needs none of them, so the SDK drops them before a request leaves.
   */
  droppedHeaderPrefix: 'x-stainless-',
} as const;
