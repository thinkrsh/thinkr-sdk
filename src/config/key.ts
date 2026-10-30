/**
 * The shape of an API key of Thinkr Inference: a prefix, then the secret of a balance, which is 32
 * random bytes in base64url without padding. The proxy keeps only a hash of the secret.
 */
export const API_KEY = {
  prefix: 'thkr_',
  secretChars: 43,
  /** The characters of base64url, as a class of a regular expression. */
  secretCharClass: 'A-Za-z0-9_-',
} as const;
