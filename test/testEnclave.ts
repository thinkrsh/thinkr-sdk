import { KEM_DHKEM_X25519_HKDF_SHA256 } from '@panva/hpke-noble';
import {
  deriveResponseKeys,
  encryptChunk,
  EXPORT_LABEL,
  EXPORT_LENGTH,
  HPKE_REQUEST_INFO,
  PROTOCOL,
  RESPONSE_NONCE_LENGTH,
} from 'ehbp';
import { AEAD_AES_256_GCM, CipherSuite, KDF_HKDF_SHA256, type KeyPair } from 'hpke';
import { toHex } from '../src/lib/bytes.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One sealed request as the test enclave opened it. */
export interface OpenedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly plaintext: string;
}

/** What the test enclave answers: frames to seal, or a response it sends as it is. */
export type EnclaveAnswer =
  | { readonly status: number; readonly contentType: string; readonly frames: readonly string[] }
  | { readonly plain: Response };

function suite(): CipherSuite {
  return new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM);
}

function frame(ciphertext: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + ciphertext.length);
  new DataView(framed.buffer).setUint32(0, ciphertext.length, false);
  framed.set(ciphertext, 4);
  return framed;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * An enclave for the tests. It opens each sealed request as any EHBP server does, and seals its
 * answer with the response primitives of the reference implementation (`ehbp`, MIT), so the SDK is
 * checked against code that it does not share.
 */
export class TestEnclave {
  readonly opened: OpenedRequest[] = [];
  readonly plainRequests: string[] = [];

  private constructor(
    private readonly keyPair: KeyPair,
    readonly publicKeyHex: string,
    private readonly answers: (() => EnclaveAnswer)[],
  ) {}

  static async create(answers: (() => EnclaveAnswer)[]): Promise<TestEnclave> {
    const keyPair = await suite().GenerateKeyPair(true);
    const publicKeyHex = toHex(await suite().SerializePublicKey(keyPair.publicKey));
    return new TestEnclave(keyPair, publicKeyHex, answers);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const encapsulated = request.headers.get(PROTOCOL.ENCAPSULATED_KEY_HEADER);
    if (encapsulated === null) {
      this.plainRequests.push(request.url);
      throw new Error(`The test enclave got a request with no seal: ${request.url}`);
    }
    const encapsulatedKey = fromHex(encapsulated);
    const context = await suite().SetupRecipient(this.keyPair, encapsulatedKey, {
      info: encoder.encode(HPKE_REQUEST_INFO),
    });
    const body = new Uint8Array(await request.arrayBuffer());
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < body.length;) {
      const length = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, false);
      parts.push(await context.Open(body.slice(offset + 4, offset + 4 + length)));
      offset += 4 + length;
    }
    this.opened.push({
      url: request.url,
      headers: request.headers,
      plaintext: decoder.decode(concat(parts)),
    });
    const answer = this.answers[this.opened.length - 1];
    if (answer === undefined) throw new Error('The test enclave has no answer left.');
    const planned = answer();
    if ('plain' in planned) return planned.plain;
    const secret = await context.Export(encoder.encode(EXPORT_LABEL), EXPORT_LENGTH);
    const nonce = crypto.getRandomValues(new Uint8Array(RESPONSE_NONCE_LENGTH));
    const keys = await deriveResponseKeys(secret, encapsulatedKey, nonce);
    const sealed = await Promise.all(
      planned.frames.map(async (text, index) =>
        frame(await encryptChunk(keys, index, encoder.encode(text))),
      ),
    );
    return new Response(new Uint8Array(concat(sealed)), {
      status: planned.status,
      headers: {
        'Content-Type': planned.contentType,
        [PROTOCOL.RESPONSE_NONCE_HEADER]: toHex(nonce),
      },
    });
  };
}
