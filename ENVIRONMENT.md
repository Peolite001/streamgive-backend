# Environment variables

Copy `.env.example` to `.env` (and `.env.test.example` to `.env.test` for
the test suite) and fill these in.

| Variable                      | Required | Default                                | Notes                                                                                          |
| ------------------------------ | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | Yes      | —                                        | Postgres connection string. Inside `docker compose`, the backend service overrides this to point at the `postgres` service, not `localhost`. |
| `PORT`                         | No       | `3000`                                   | Port the Fastify server listens on.                                                              |
| `SOROBAN_RPC_URL`               | No       | `https://soroban-testnet.stellar.org`    | Soroban RPC endpoint the indexer polls.                                                          |
| `NGO_REGISTRY_CONTRACT_ID`      | No*      | — (empty)                                | Deployed `ngo-registry` contract id. See `streamgive-contracts/deployments.json`. The indexer no-ops until both contract ids are set. |
| `DONATION_VAULT_CONTRACT_ID`    | No*      | — (empty)                                | Deployed `donation-vault` contract id. Same file as above.                                       |
| `INDEXER_POLL_INTERVAL_MS`      | No       | `5000`                                   | How often the indexer polls `getEvents`. Doubles on each consecutive poll failure, up to a 5-minute cap; see [`docs/INDEXER.md`](./docs/INDEXER.md). |
| `CORS_ORIGINS`                  | No       | `http://localhost:3001`                  | Comma-separated origins allowed to call this API from a browser.                                |
| `ADMIN_ADDRESS`                 | No**     | — (empty)                                | Stellar public key (`G...`) that must sign requests to admin routes (`/ngo-applications` review). Admin routes 503 until this is set. Should match the `admin` configured on the deployed contracts. |
| `NOTIFY_WEBHOOK_URL`            | No       | — (empty)                                | If set, stream lifecycle events (`stream_created`/`stream_withdrawn`/`stream_cancelled`) are POSTed here as JSON.                                |
| `NOTIFY_WEBHOOK_SECRET`         | No       | — (empty)                                | If set, every webhook POST carries an `x-streamgive-signature` header holding the lower-case hex HMAC-SHA256 of the raw request body, keyed with this value, so receivers can reject forged notifications. The header is omitted entirely when this is unset. See the README's notification section for the verification recipe. |
| `RATE_LIMIT_MAX`                | No       | `100`                                    | Global maximum number of requests allowed per time window across the API.                      |
| `RATE_LIMIT_WINDOW`             | No       | `1 minute`                               | Global rate limit time window (e.g. `1 minute`, `10000` ms).                                    |
| `RATE_LIMIT_APPLICATION_MAX`    | No       | `5`                                      | Maximum number of NGO application submissions allowed per time window.                         |
| `RATE_LIMIT_APPLICATION_WINDOW`| No       | `1 minute`                               | Rate limit time window for NGO application submissions.                                         |
| `TRUST_PROXY`                   | No       | `true`                                   | Controls Fastify `trustProxy` setting to read client IP from `X-Forwarded-For`. Behind reverse proxies like Render, this ensures rate limiting keys by individual client IP rather than the proxy IP. Accepts `true` (default), `false`, a bounded hop count (e.g. `1`), or a comma-separated list of trusted IPs/CIDRs. |
| `LOG_LEVEL`                     | No       | `info`                                   | Pino log level: `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`.                     |
| `NODE_ENV`                      | No       | unset (treated as development)           | Set to `production` to switch logging to structured JSON instead of pino-pretty. Set automatically inside the Docker image. |

\* Required for the indexer to do anything; the app runs fine without them, it just never sees on-chain events.
\*\* Required for the admin review endpoints to work at all; everything else in the API works without it.


| `RESEND_API_KEY` | No | — | Resend API key used to send email notifications. Email notifications remain in log-only stub mode when this is unset. |
| `NOTIFY_EMAIL_FROM` | No | — | Sender address used by Resend. Required when `RESEND_API_KEY` is configured. |
| `NOTIFY_EMAIL_TO` | No | — | Recipient address for notification emails. Email notifications are skipped when this is unset. |