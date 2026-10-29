# Shared agenda API

The Worker stores one shared agenda in D1. `GET /api/agenda` is public and returns
`{version:1,language:"es",revision,events}`. The first valid read or authenticated
write initializes missing data from `Trip.SEED` at revision 0; existing data,
including an empty calendar, is never reset.

`PUT /api/agenda` requires `X-Family-Passphrase` and exactly the same envelope
with the revision last read. A successful atomic update returns the saved
snapshot at revision + 1. HTTP 409 returns `{error,current}` instead of
overwriting another edit. Clients must reconcile and retry explicitly.

Errors use Spanish `{error}` messages: 400 for invalid JSON/envelopes/events,
401 for a missing/incorrect write key, 403 for disallowed origins or preflight
headers, 404/405 for unsupported routes/methods, 413 for bodies or encoded
events over 1 MiB, and 503 for unavailable storage or server configuration.
All responses disable caching and vary by Origin. Allowed origins are the
GitHub Pages site and local frontend servers on port 8788; no-Origin requests
are accepted, but writes still require authentication.

Write authentication uses the `FAMILY_AUTH` service binding to the existing
`atlas-family-chat` Worker (`POST /api/verify`). Only that service owns the family
secret: this Worker neither stores a copy nor accepts a separate secret.
Unavailable bindings, verifier failures, unexpected statuses, malformed replies,
and replies without `ok: true` fail closed with 503. Verifier 401/403 map to 401.

## Provision and deploy

Production uses the existing `iberia-trip-agenda` database configured in
`wrangler.toml`. Reuse that binding when deploying updates.

From this directory, after authenticating the intended personal Cloudflare account:

```powershell
npm ci
npm run migrate
npm run deploy
```

For a separate installation, first run `npx wrangler d1 create iberia-trip-agenda`
and update `database_id` before migrating. Do not recreate or reset the existing
database to deploy an update.

The existing `atlas-family-chat` service must be deployed in the same account
for the service binding. Do not copy its secret into this project. The returned
Worker URL followed by `/api/agenda` is the endpoint in `sync-config.js`.
Migrations create the schema only;
they do not contain or reset agenda data. D1 failures never return seed data
as a fallback.

For local development, run `npm run migrate:local`, then `npm run dev` (port
8790). Remote and local databases are separate. Local writes also need a
reachable `atlas-family-chat` service in Wrangler's service-binding development
setup; an unavailable verifier intentionally returns 503.

## Focused tests

`npm test` requires Node 24 with `node:sqlite`, but no installed dependencies.
Tests execute the migration and API SQL against real in-memory SQLite, using
synthetic edits and no credentials, browser backups, or itinerary output.
