# Shared agenda API

The Worker stores one shared agenda in D1. `GET /api/agenda` is public and returns
`{version:1,language:"es",revision,events}`. The first valid read or
write initializes missing data from `Trip.SEED` at revision 0; existing data,
including an empty calendar, is never reset.

`PUT /api/agenda` is also public and accepts exactly the same envelope
with the revision last read. A successful atomic update returns the saved
snapshot at revision + 1. HTTP 409 returns `{error,current}` instead of
overwriting another edit. Clients must reconcile and retry explicitly.

Errors use Spanish `{error}` messages: 400 for invalid JSON/envelopes/events,
403 for disallowed origins or preflight
headers, 404/405 for unsupported routes/methods, 413 for bodies or encoded
events over 1 MiB, and 503 for unavailable storage or server configuration.
All responses disable caching and vary by Origin. Allowed origins are the
GitHub Pages site and local frontend servers on port 8788; no-Origin requests
are accepted.

Anyone with the site link or API endpoint can edit without a password, account,
or key. The origin allowlist is a browser policy, not authentication.
The obsolete `X-Family-Passphrase` header remains allowed but is ignored, so
already-open older clients can still save until they refresh.

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

The returned Worker URL followed by `/api/agenda` is the endpoint in
`sync-config.js`. Migrations create the schema only; they do not contain or reset
agenda data. D1 failures never return seed data as a fallback.

For local development, run `npm run migrate:local`, then `npm run dev` (port
8790). Remote and local databases are separate. No family authentication service
or credential is needed.

## Focused tests

`npm test` requires Node 24 with `node:sqlite`, but no installed dependencies.
Tests execute the migration and API SQL against real in-memory SQLite, using
synthetic edits and no credentials, browser backups, or itinerary output.
