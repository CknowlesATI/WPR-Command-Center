# Hosted Command Center

This folder is the separate online/shared version of Project Command Center.
It is intentionally kept apart from the current Google Apps Script operating
baseline at the repository root.

## Purpose

The hosted version is for WPR techs and project participants who need a quick,
read-focused view of what needs attention across WPR projects without opening
Pulse and Procore one project at a time.

This version should stay:

- Read-focused by default.
- Mobile and tablet friendly.
- Sanitized for broader access.
- Lightweight enough to host on free static hosting.
- Separate from the current personal/internal Command Center workflow.

## Current Shape

- `index.html` is the first read-only hosted dashboard shell.
- `data/projects.json` is the data file the hosted dashboard loads.
- `data/projects.sample.json` is the example data contract for future sync work.
- `tools/export-hosted-data.mjs` converts current Command Center API data into
  the safer hosted data shape.
- `tools/validate-hosted-data.mjs` checks that hosted data follows the shared
  read-only contract.
- `run-preview.ps1` starts a local preview for this hosted folder.
- `DATA_CONTRACT.md` documents the safe shared data shape.

The current dashboard uses static JSON so it can be hosted without a paid
database or backend. Later phases can add a cloud sync job or database only if
the static data file becomes too limiting.

## No-Subscription Hosting Path

The intended first hosting path is GitHub Pages, Cloudflare Pages, Netlify, or
Vercel free tier. No custom domain is required.

The lowest-complexity option is:

1. Publish this folder as a static site.
2. Generate or update `data/projects.json` from sanitized Command Center data.
3. Keep the dashboard read-only for viewers.

The included GitHub Pages workflow publishes this folder and can refresh the
hosted data automatically when the repository has a private secret named
`COMMAND_CENTER_API_URL`.

## Data Export

The hosted data file can be generated from the existing Command Center API:

```powershell
node hosted-command-center/tools/export-hosted-data.mjs --url "<Apps Script URL>"
```

Or by setting `COMMAND_CENTER_API_URL` before running the script.

By default, the export does not include task notes, raw external IDs, or source
links. Source links can be added later with `--include-links` only after the
links are reviewed and considered safe for the intended audience.

The GitHub Pages workflow is scheduled for weekday mornings and can also be run
manually.

Hosted data can be checked with:

```powershell
node hosted-command-center/tools/validate-hosted-data.mjs
```

## Data Safety Rules

Before using real data online, remove or avoid exposing:

- Private Pulse notes that should not be broadly visible.
- Sensitive Procore links or attachment URLs.
- Credentials, internal IDs, and sync details.
- Financial, contractual, personnel, or access-sensitive details.

The public/shared view should show enough signal to guide action, then send the
tech back to Pulse or Procore only when deeper work is needed.
