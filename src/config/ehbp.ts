/**
 * The problem that an EHBP server sends when a request was sealed to a key it no longer holds:
 * section 5.4.3 of the specification of EHBP, as its reference client `ehbp` 0.4.1 (MIT) reads it,
 * checked 29 Oct 2026. The client verifies the enclave again and sends the request once more. The
 * proxy of Thinkr passes this problem through as it is.
 */
export const KEY_CONFIG_PROBLEM = {
  status: 422,
  mediaType: 'application/problem+json',
  type: 'urn:ietf:params:ehbp:error:key-config',
  /** The most of a problem body that the SDK reads, as the reference client does. */
  maxBytes: 64 * 1024,
} as const;
