# StreamGive — Backend

Indexer and API for StreamGive, a recurring/streaming donation platform for
verified NGOs on Stellar. Watches the on-chain contracts for events and
serves the data that powers the frontend.

## Stack

- TypeScript, Node.js
- Fastify (API server)
- PostgreSQL

## API

Every HTTP API route is mounted under `/v1`, including health and admin routes.
For example: `GET /v1/health`, `GET /v1/ngos`, `GET /v1/streams`, and
`GET /v1/indexer/status`.

## NGO Verification Model

An NGO's verified status consists of two distinct steps kept deliberately separate:

1. **Off-Chain Application Review (`NgoApplication.status`)**: An NGO submits an off-chain application containing organization details and verification documents. Admins review and update the application status (e.g., `APPROVED` or `REJECTED`) within the database.
2. **On-Chain Contract Approval (`Ngo.verified`)**: Once an application is reviewed off-chain, an admin executes an on-chain transaction (`approve_ngo`) to grant the NGO verified status on the Stellar smart contract. The indexer listens for on-chain events (`ngo_approved` / `ngo_revoked`) and updates the `Ngo.verified` field accordingly.

Keeping off-chain application review separate from on-chain contract approval ensures that sensitive organizational details and review metadata remain off-chain, while the Stellar ledger remains the single source of truth for execution permissions and verified status.

## Admin Authentication

Admin routes are protected by a signed request scheme (`requireAdminSignature`). Each request must include:

- `x-admin-address` — the admin's Stellar public key (`G...`), which must match `ADMIN_ADDRESS`.
- `x-admin-timestamp` — the current time as a Unix timestamp in **milliseconds** (e.g. `Date.now()` in JavaScript).
- `x-admin-signature` — a signature over the request payload including the timestamp.

The timestamp must be within a±5-minute skew of the server's clock. The unit is
**milliseconds**, not seconds. A client that sends a Unix timestamp
in seconds (typically 10 digits) will be rejected with a `stale_signature`
error. To avoid ambiguity, the server explicitly rejects timestamps that
look like seconds with a clear `admin_timestamp_unit` error instead of a
generic stale-signature failure.

## Local development

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev

```

In development, interactive API documentation is available at `http://localhost:3000/docs`; the OpenAPI document is at `/docs/json`. Swagger UI is disabled in production.

```
bash
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:migrate              # apply Prisma migrations to streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

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

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```
