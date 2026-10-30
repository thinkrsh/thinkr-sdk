/** The mistakes that the SDK stops on before anything leaves this machine. */
export const THINKR_ERROR_CODES = [
  'invalid_api_key',
  'invalid_base_url',
  'invalid_request',
  'attestation_unavailable',
] as const;

export type ThinkrErrorCode = (typeof THINKR_ERROR_CODES)[number];

/**
 * An error of the SDK itself. A failed verification throws the `VerificationError` of
 * `@thinkr/verifier` instead, and an answer of the API throws an error of the OpenAI client.
 */
export class ThinkrError extends Error {
  override readonly name = 'ThinkrError';

  constructor(
    readonly code: ThinkrErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
