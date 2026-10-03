# StreamGive — Backend

Indexer and API for StreamGive, a recurring/streaming donation platform for
verified NGOs on Stellar. Watches the on-chain contracts for events and
serves the data that powers the frontend.

## Stack

- TypeScript, Node.js
- Fastify (API server)
- PostgreSQL

## NGO Verification Model

An NGO's verified status consists of two distinct steps kept deliberately separate:

1. **Off-Chain Application Review (`NgoApplication.status`)**: An NGO submits an off-chain application containing organization details and verification documents. Admins review and update the application status (e.g., `APPROVED` or `REJECTED`) within the database.
2. **On-Chain Contract Approval (`Ngo.verified`)**: Once an application is reviewed off-chain, an admin executes an on-chain transaction (`approve_ngo`) to grant the NGO verified status on the Stellar smart contract. The indexer listens for on-chain events (`ngo_approved` / `ngo_revoked`) and updates the `Ngo.verified` field accordingly.

Keeping off-chain application review separate from on-chain contract approval ensures that sensitive organizational details and review metadata remain off-chain, while the Stellar ledger remains the single source of truth for execution permissions and verified status.

## Local development

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

In development, browse the interactive API documentation at `http://localhost:3000/docs`.
The generated OpenAPI JSON is available at `http://localhost:3000/docs/json`. The docs describe
the public read endpoints; the Swagger UI is disabled in production.

`npm run db:seed` uses upserts, so it is safe to run more than once.

To run the whole stack containerized instead, after `npm run db:push` above: `docker compose up --build`.

To run the integration test suite, additionally:

```
cp .env.test.example .env.test
npm run db:push:test
npm test
```

## Troubleshooting

**"Can't reach database" / connection errors on startup**

Postgres isn't up yet, or `DATABASE_URL` doesn't point at it. Run
`docker compose up -d postgres` and confirm `DATABASE_URL` in `.env` matches
(`postgresql://streamgive:streamgive@localhost:5432/streamgive` when running
`npm run dev` directly — the `postgres` host only resolves inside
`docker compose`, see the override in `docker-compose.yml`). Then run
`npm run db:push` to sync the schema.

**Indexer never picks up events**

If `NGO_REGISTRY_CONTRACT_ID` and `DONATION_VAULT_CONTRACT_ID` are both
unset, this is expected — the indexer no-ops until at least one is set. See
[ENVIRONMENT.md](./ENVIRONMENT.md) for where to get the deployed contract
ids. If they're set and events still aren't showing up, check
`SOROBAN_RPC_URL` is reachable and that the contracts have actually emitted
events since the indexer's checkpoint (a fresh run starts from the current
ledger, not from the contract's history).

**Admin routes return 503**

`ADMIN_ADDRESS` is unset. The admin review endpoints refuse all requests
until it's configured — set it to the Stellar public key (`G...`) that
matches the `admin` configured on the deployed contracts. See
[ENVIRONMENT.md](./ENVIRONMENT.md).

## Indexer

See [docs/INDEXER.md](./docs/INDEXER.md) for a full table of which on-chain
events the indexer handles, which tables each one writes, and how the
checkpoint and out-of-window recovery work.

## Notification events

When `NOTIFY_WEBHOOK_URL` is set, the indexer POSTs a JSON body to that URL
for each on-chain event it processes (see
[src/notifications/service.ts](./src/notifications/service.ts)). The body is
one of the following shapes, discriminated by `type`
(see [src/notifications/types.ts](./src/notifications/types.ts)):

### Verifying the signature

The webhook URL is not a secret — anyone who learns it can POST whatever they
like to your receiver. Set `NOTIFY_WEBHOOK_SECRET` to a shared secret and
every request will additionally carry:

```
x-streamgive-signature: <hex>
```

where `<hex>` is the lower-case hex HMAC-SHA256 of the **raw request body**,
keyed with `NOTIFY_WEBHOOK_SECRET`. There is no prefix, timestamp or version
tag in the value — it is the bare digest.

Verify it against the bytes you read off the wire, before parsing them as
JSON: re-serialising the parsed object can reorder keys or change whitespace,
and the digest would no longer match. Compare in constant time so the
comparison itself does not leak the expected digest a byte at a time.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromStreamGive(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader, 'hex');

  // timingSafeEqual throws on a length mismatch, so check that first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

Reject any request whose signature does not match, and any unsigned request
once you have configured a secret. When `NOTIFY_WEBHOOK_SECRET` is unset the
header is omitted entirely, so receivers can be rolled out before the secret
is configured — but an endpoint that accepts unsigned requests is exactly the
hole the header exists to close, so treat that as a migration step rather
than a resting state.

### `stream_created`

Emitted when a donor opens a new donation stream to an NGO.

```json
{
  "type": "stream_created",
  "streamId": "1234",
  "donorAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `streamId` — the stream's on-chain id, as a string.
- `donorAddress` — the donor's Stellar account address.
- `ngoId` — the internal (database) id of the receiving NGO.

### `stream_withdrawn`

Emitted when accrued funds are withdrawn to the NGO from an active stream.

```json
{
  "type": "stream_withdrawn",
  "streamId": "1234",
  "amount": "500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `amount` — the amount withdrawn, in the stream's token base units, as a string.

### `stream_cancelled`

Emitted when a stream is cancelled, settling accrued funds to the NGO and
refunding the remaining balance to the donor.

```json
{
  "type": "stream_cancelled",
  "streamId": "1234",
  "settledToNgo": "500000000",
  "refundToDonor": "1500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `settledToNgo` — the amount settled to the NGO at cancellation time, in the stream's token base units, as a string.
- `refundToDonor` — the amount refunded to the donor, in the stream's token base units, as a string.

### `ngo_approved`

Emitted when an admin approves an NGO on-chain.

```json
{
  "type": "ngo_approved",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the approved NGO.

### `ngo_revoked`

Emitted when a previously-approved NGO has its verified status revoked on-chain.

```json
{
  "type": "ngo_revoked",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the revoked NGO.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run tests, and
how to open a pull request. The full project-wide contribution guide lives in
[streamgive-docs](https://github.com/streamgive/streamgive-docs).

## Related repositories

- [streamgive-contracts](https://github.com/streamgive/streamgive-contracts) — Soroban smart contracts
- [streamgive-frontend](https://github.com/streamgive/streamgive-frontend) — donor & NGO web app
- [streamgive-docs](https://github.com/streamgive/streamgive-docs) — documentation

## Status

Early development.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Local development

```bash
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:migrate              # apply Prisma migrations to streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```
