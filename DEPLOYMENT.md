# Deploying the backend

This service is a Fastify API and a Soroban event indexer running in one
process. It needs a Postgres database and a deployed pair of contracts —
contract ids for the current testnet deployment are in
`streamgive-contracts/deployments.json`.

It is deployed on Render's free tier from `render.yaml`, using the
Dockerfile in this directory. Any host that can run a container works; the
one real constraint is discussed under "Keeping it awake".

## Prerequisites

- A Postgres database reachable from the internet. Supabase's free tier is
  fine — use the **session pooler** connection string, not the direct one,
  which resolves to IPv6 only and will fail from most networks.
- The frontend's public URL, for `CORS_ORIGINS`.

## First deploy

In Render: **New → Blueprint**, point it at this repository, and let it read
`render.yaml`. It will prompt for the three values marked `sync: false`:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session pooler URL, password percent-encoded |
| `ADMIN_ADDRESS` | the `G...` wallet that is admin on the deployed registry |
| `CORS_ORIGINS` | the frontend's URL, e.g. `https://streamgive.vercel.app` |

Everything else — contract ids, RPC URL, poll interval — is in `render.yaml`
already, since none of it is secret.

## The ordering problem

The frontend needs this API's URL, and this API needs the frontend's URL for
`CORS_ORIGINS`. Neither exists before the other, so:

1. Deploy this backend and note its URL (`https://<name>.onrender.com`)
2. Deploy the frontend with `NEXT_PUBLIC_API_URL` set to that
3. Come back and set `CORS_ORIGINS` to the frontend's real URL

Until step 3, every browser request fails as `Failed to fetch`, which looks
like the server being down rather than a CORS refusal. It isn't. Put a
placeholder in at step 1 and correct it at step 3.

## Database schema

The app does not migrate on boot. Push the schema from a machine that has
`DATABASE_URL` set:

```sh
npx prisma db push
```

## Keeping it awake

Render's free web services **spin down after about 15 minutes without HTTP
traffic**, and take 30–60 seconds to wake. Two consequences:

- A visitor arriving cold waits through that wake-up on a blank page.
- While stopped, nothing is indexed. The indexer runs inside this process.

Missed events are *recoverable* rather than lost, because the Soroban RPC
retains roughly **7 days** of ledgers (`ledgerRetentionWindow`, currently
120,960 ledgers at ~5s each). On wake, the indexer resumes from its saved
checkpoint and catches up. Only a gap longer than that window is
unrecoverable — at which point it resyncs to the current ledger and logs a
warning naming what it skipped.

The fix for both problems is an external uptime pinger hitting
`/health` every 10 minutes — any free service (cron-job.org, UptimeRobot)
will do. That keeps the service awake, which also keeps the Supabase project
clear of its own 7-day inactivity pause.

One caveat: Render's free plan allows 750 instance-hours per month and a
month is about 730 hours, so a permanently-awake service consumes nearly the
whole allowance. That budget covers **one** free service, not several.

## Notes on Supabase

- Free-tier projects pause after 7 days of inactivity. The pinger above
  keeps this service querying the database, which keeps the project active.
- Percent-encode the password in the connection URL. A literal `#`
  truncates it, and a literal `@` breaks host parsing.


This is particularly important because the current deployment documentation explicitly says:

> The app does not migrate on boot. Push the schema from a machine that has `DATABASE_URL` set.

and then:

```bash
npx prisma db push