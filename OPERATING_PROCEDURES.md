# Command Center Operating Procedures

## Default Work Target

The active Command Center product is the online GitHub Pages + Cloudflare
version.

The original Google Apps Script command center is a legacy/reference
implementation. Use it as a source for proven workflow ideas only when needed,
but do not maintain it as a separate long-term user experience unless Christen
explicitly asks for that.

## Version Map

Online Command Center:

- Source page: `hosted-command-center/index.html`
- Public page served by GitHub Pages: `index.html`
- Published fallback data: `hosted-command-center/data/projects.json`
- Live API: `https://wpr-command-center-api.wpr-command-center.workers.dev`
- Live database: Cloudflare D1 `wpr-command-center`
- Worker source: `worker/src/index.js`
- Validation: `hosted-command-center/tools/validate-hosted-data.mjs`
- Intended publishing path: push root `index.html` to `main`

Legacy/reference path:

- Apps Script backend: `Code.gs`
- Former data source: Google Sheet through the Apps Script web app URL
- Use: legacy/reference only unless explicitly requested

## Before Making Changes

1. Run `git status --short --branch`.
2. Inspect any uncommitted changes and preserve work from other chats.
3. Confirm the request targets the online Command Center unless Christen says
   otherwise.
4. Update `hosted-command-center/index.html` first, then mirror it to root
   `index.html`.
5. State clearly when a change needs to touch the Cloudflare Worker or D1
   database.

## Verification

For online Command Center UI changes:

- Check the affected files under `hosted-command-center/`.
- Keep root `index.html` mirrored with `hosted-command-center/index.html`.
- Parse both page scripts.
- Validate `hosted-command-center/data/projects.json` when the static snapshot
  contract changes.
- When publishing, push both `codex/phase-3-outcome-control` and `main`, then
  confirm GitHub Pages is serving the update.

For Cloudflare Worker or D1 changes:

- Check `worker/src/index.js`.
- Add a migration under `worker/migrations/` for schema changes.
- Apply remote migrations with Wrangler.
- Deploy the Worker with `worker/wrangler.toml`.
- Test the live Worker endpoint before reporting completion.

For Apps Script API changes, only when explicitly requested:

- Check `Code.gs`.
- Push `Code.gs` with clasp when backend code changes.
- Treat it as legacy/reference work, not the current online Command Center
  path.
