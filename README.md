# Thinkr SDK

This package gives you an OpenAI client for Thinkr Inference. For a model of the private lane, the
client verifies the enclave on your machine before it sends anything. It then encrypts each request
body to that enclave, so the proxy of Thinkr and every other server on the way see only ciphertext.

The API also serves the models of the modes ZDR and Open, which run outside an enclave. Their ids
start with `zdr/` or `open/`, and the client sends them as plain JSON. See
[Call a model of ZDR or Open](#call-a-model-of-zdr-or-open).

Your existing OpenAI code keeps working: the client takes the same calls, streaming included.

## Install

You need Node 22.12 or later.

```sh
npm install @thinkr/sdk
```

## Get an API key

Create a key at [chat.thinkr.sh/keys](https://chat.thinkr.sh/keys). Set its limit in dollars
there, and that much moves from your balance in the app onto the key. Keep the key secret. Anyone
who has it can spend its credit.

## Quickstart

```ts
import { createClient } from '@thinkr/sdk';

const ai = createClient({ apiKey: process.env.THINKR_API_KEY });

const completion = await ai.chat.completions.create({
  model: 'gpt-oss-120b',
  messages: [{ role: 'user', content: 'Summarize this contract in three lines.' }],
});

console.log(completion.choices[0]?.message.content);
```

To stream the answer, add `stream: true` and read the chunks as they arrive:

```ts
const stream = await ai.chat.completions.create({
  model: 'gpt-oss-120b',
  messages: [{ role: 'user', content: 'Write a haiku about enclaves.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
```

`ai.models.list()` lists the models with their modes and prices. To see the credit left on your
key, call `await ai.get('/balance')`, which returns `{ usd }`.

## Call a model of ZDR or Open

A model whose id starts with `zdr/` or `open/` runs outside an enclave. The client sends its chat as
plain JSON, with no verification, and encrypts every other id. Only the id that you write decides
this, so no server can turn a chat of the private lane into a plain one.

```ts
const completion = await ai.chat.completions.create({
  model: 'zdr/claude-sonnet-5.5',
  messages: [{ role: 'user', content: 'Summarize this contract in three lines.' }],
});
```

The proxy of Thinkr, OpenRouter, and the provider of the model can read such a chat. ZDR sends it
only to providers under zero data retention. In Open, the provider may keep it for a while.

These chats need no SDK. Any OpenAI client or HTTP tool can call `https://api.thinkr.sh/v1` directly
with your API key:

```sh
curl https://api.thinkr.sh/v1/chat/completions \
  -H "Authorization: Bearer $THINKR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "zdr/claude-sonnet-5.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

A chat runs to its end even when your connection closes, and the key pays for the whole answer.

## How verification works

The client verifies the enclave before its first chat, with
[`@thinkr/verifier`](https://github.com/thinkrsh/thinkr-verifier):

1. The client fetches the attestation bundle of the router enclave from the API.
2. AMD must have signed the report of the enclave, an AMD SEV-SNP trusted execution environment
   (TEE).
3. The release must be signed in Sigstore, and the enclave must run that release.
4. The certificate of the enclave must carry the attested keys.

If any step fails, the client sends nothing. When every step passes, the client encrypts each
request body with Hybrid Public Key Encryption (HPKE) to the key of that enclave, and opens the
encrypted answer as it streams.

The client keeps a verification for 15 minutes, then verifies again. If the enclave changes its key
before then, the client verifies again at once and sends the request one more time. The proxy of
Thinkr forwards the encrypted bytes.

To check the enclave yourself, without sending a chat:

```ts
import { verifyEnclave } from '@thinkr/sdk';

const verification = await verifyEnclave();
console.log(verification.enclaveHost, verification.releaseTag);
```

## Use Postman, curl, or another language

To call a model of the private lane, a program that cannot encrypt goes through the local bridge of
this package. The bridge runs on your machine, verifies the enclave, and encrypts each chat before
it leaves. To start it:

```sh
npx @thinkr/sdk serve
```

The bridge listens on `http://127.0.0.1:4141/v1`, on your machine only. To use another port, add
`--port <port>`. Send a chat to it as plain JSON, with your API key as a Bearer token:

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer $THINKR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-oss-120b", "messages": [{"role": "user", "content": "Hello"}]}'
```

The answer has the shape of the OpenAI API, and `"stream": true` streams it. The bridge also answers
`GET /v1/models`, `GET /v1/attestation`, and `GET /v1/balance`, and passes a chat of ZDR or Open on
as plain JSON. It refuses requests from web pages, and it keeps your key in memory only. If a verification fails, it answers `502` with the code
`verification_failed` and sends nothing.

### Send the ciphertext yourself

To see what leaves your machine, run a chat in three requests. The answer comes whole, with no
stream.

1. `POST http://127.0.0.1:4141/v1/encrypt` takes the plain JSON of a chat and your API key. It
   returns the `id` of the chat, the `url`, the `headers`, and the encrypted `body` in base64url.
2. `POST https://api.thinkr.sh/v1/chat/completions` takes that `body` as the request body, those
   `headers`, and your API key. It returns the encrypted answer as `nonce` and `ciphertext`.
3. `POST http://127.0.0.1:4141/v1/decrypt` takes `id`, `nonce`, and `ciphertext` as JSON, and
   returns the answer in the shape of the OpenAI API.

The secrets that decrypt the answer stay in the memory of the bridge for 10 minutes, and each answer
decrypts once. `postman/thinkr-encrypted-chat.postman_collection.json` runs these three requests in
Postman and carries each value to the next. Put your API key in its variable `api_key`, in the
Current value.

## Errors

- `ThinkrError`: the client stopped before it sent anything. Its `code` says why:
  `invalid_api_key`, `invalid_base_url`, `invalid_request`, or `attestation_unavailable`.
- A failed verification: the call rejects with the `APIConnectionError` of the OpenAI client.
  Its `cause` is a `VerificationError`, and `cause.step` names the step that failed.
  `verifyEnclave()` throws the `VerificationError` directly.
- An error of the API, such as a key with too little credit: the OpenAI client throws an
  `APIError` with the HTTP status and the message of the API.

## Use a local proxy

When you run the proxy of Thinkr on your machine, point the client at it. The client accepts plain
HTTP only on the loopback, since every request carries your API key:

```ts
const ai = createClient({
  apiKey: process.env.THINKR_API_KEY,
  baseURL: 'http://127.0.0.1:8787/api/inference/v1',
});
```

## Development

- To run the formatter, the linter, the type checker, and the tests, run `npm run check`.
- To build `dist/`, run `npm run build`.

## License

Apache License 2.0. See `LICENSE`.
