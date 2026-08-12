# WPR Command Center Codex Instructions

## Source Of Truth

The active product is the online WPR Command Center:

- Public site: `https://cknowlesati.github.io/WPR-Command-Center/`
- Public page file: `index.html`
- Source page file: `hosted-command-center/index.html`
- Live API: `https://wpr-command-center-api.wpr-command-center.workers.dev`
- Cloudflare Worker source: `worker/src/index.js`
- Cloudflare D1 database: `wpr-command-center`
- Current working branch: `codex/phase-3-outcome-control`

When changing the Command Center UI, update `hosted-command-center/index.html`
first, then mirror it to root `index.html`. GitHub Pages serves the root
`index.html`.

## What Not To Treat As Current

`Code.gs`, Google Apps Script, and Google Sheet workflows are legacy/reference
paths unless Christen explicitly asks to work on them. Do not implement new
Command Center behavior only in `Code.gs`.

The branch `codex/hosted-shared-command-center` is an older separated version
and should not be used as the target for new work unless Christen explicitly
asks to inspect historical work.

## Before Any Edit

1. Run `git status --short --branch`.
2. If files are already modified, inspect the diff and preserve that work.
3. Confirm the change is being made against the online Command Center files
   above, not a legacy/internal version.
4. Keep `hosted-command-center/index.html` and root `index.html` in sync.

## Verification

For UI-only changes:

- Parse both page scripts.
- Validate hosted data when the data contract is touched.
- Push both `codex/phase-3-outcome-control` and `main` when publishing.
- Confirm GitHub Pages is serving the expected update.

For Worker/database changes:

- Run `node --check worker/src/index.js`.
- Apply new D1 migrations with `wrangler d1 migrations apply ... --remote`.
- Deploy with `wrangler deploy --config worker/wrangler.toml`.
- Test the live Worker endpoint before reporting completion.

## Current Features To Preserve

- Project drill-down from the main project list.
- Editable manual Command Center To-Dos and Notes.
- Pulse and Procore items grouped separately and not editable in Command Center.
- Closed Items collapsed by default.
- Project add/close workflows.
- Settings tab with notification recipients and recent email activity.
- Email notifications through Resend for new manual To-Dos and Notes.
- Six-month edit sessions with editor initials and timestamps.
