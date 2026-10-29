# WPR Planning — authenticated DEV setup (not deployed)

This is a **development-only, fail-closed scaffold**, not a public staging API. Do not merge into main or apply migrations to the production D1 database.

## Isolation
- Dev Worker config: `worker/wrangler.planning-dev.toml`, unique name `wpr-command-center-planning-dev`
- Dev entrypoint: `worker/src/dev-index.js`, not the production `worker/src/index.js`
- Dev database must be newly created and named `wpr-command-center-planning-dev`; do not reuse production database ID `27f45859-7060-4c1b-96ca-809fc7d7e058`.
- Worker requires `DB_NAME=wpr-command-center-planning-dev` and a D1 binding, or returns 503.
- Every endpoint, including `/health`, validates a Cloudflare Access JWT (signature, issuer, audience, expiration). Anonymous requests fail closed.
- No wildcard CORS headers, external system writes, and no Procore/Pulse credentials.

## Deployment procedure (requires Cloudflare account administration; NOT performed)
1. Create a **new** D1 database `wpr-command-center-planning-dev` in Cloudflare. Record its NEW ID.
2. Add its new ID to `worker/wrangler.planning-dev.toml` with binding `DB`. Never use the production ID.
3. Create a Cloudflare Access self-hosted application for the **dev Worker hostname**, restricted to authorized ATI accounts. Use Access policy to allow only those identities. Assign a dedicated dev hostname / route; keep the public GitHub Pages sample preview distinct.
4. Configure environment variables `ACCESS_TEAM_DOMAIN` (your `*.cloudflareaccess.com` team hostname), `ACCESS_AUD` (the Access application AUD tag), and `DB_NAME=wpr-command-center-planning-dev`. Do not commit secrets.
5. Apply `worker/dev/0000_dev_projects.sql`, then `worker/migrations/0010_planning_items.sql`, using the **new dev DB's ID and explicit D1 target**. Confirm no production binding.
6. Run `node --check worker/src/dev-index.js`, `node --test tools/planning-contract.test.mjs tools/planning-sources.test.mjs tools/planning-source-adapter.test.mjs`, plus tests for actual Access rejection and D1 persist/readback.
7. Deploy **only the dev config** after security review: `npx wrangler deploy --config worker/wrangler.planning-dev.toml`. Protect `workers.dev` hostname too (or disable it), not just the custom hostname.
8. Verify unauthenticated GET/POST fail, invalid/wrong-AUD token fails, authorized read succeeds, write/readback persists **only to dev D1**, and production observations/to-dos remain unchanged.

## Current limitations
- No Cloudflare Access app, dev D1 database, or deployed dev Worker exists yet; none were created by this commit.
- Dev Worker initially supports authenticated list and create only. It is intentionally not wired to live Pulse/Procore feeds or public preview.
- Authentication depends on Cloudflare Access header injection and a restricted Access policy. Never treat JavaScript UI hiding as authentication.
- **Security gate:** Before deploying, add integration tests and verify dev DB ID, Access hostname coverage, permissions, and environment isolation.
