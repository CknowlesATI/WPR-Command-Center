# Hosted Command Center

This folder is the online version of Project Command Center. It is the intended
field-facing Command Center experience.

Unless Christen explicitly specifies otherwise, this online version is the
default target for Command Center work. See `../OPERATING_PROCEDURES.md` before
changing legacy/root app behavior.

## Purpose

The hosted version is for WPR techs and project participants who need a quick
online view of what needs attention across WPR projects without opening Pulse
and Procore one project at a time.

This version should stay:

- Mobile and tablet friendly.
- Clear enough for field use.
- Careful about what it exposes to broader access.
- Lightweight enough to host on free static hosting.
- Focused on one coherent Command Center experience.

## Current Shape

- `index.html` is the online dashboard shell.
- It loads live data from the Apps Script API when available.
- `data/projects.json` is the fallback data file the hosted dashboard loads
  when live data is unavailable.
- `data/projects.sample.json` is the example data contract for future sync work.
- `tools/export-hosted-data.mjs` converts current Command Center API data into
  the safer hosted fallback data shape.
- `tools/validate-hosted-data.mjs` checks that hosted data follows the shared
  fallback contract.
- `run-preview.ps1` starts a local preview for this hosted folder.
- `DATA_CONTRACT.md` documents the safe shared data shape.

The current dashboard uses the existing Apps Script API for live data and
editing. Static JSON remains as a no-backend fallback so the page can still be
hosted without a paid database.

## No-Subscription Hosting Path

The intended first hosting path is GitHub Pages, Cloudflare Pages, Netlify, or
Vercel free tier. No custom domain is required.

The lowest-complexity option is:

1. Publish this folder as a static site.
2. Generate or update `data/projects.json` from sanitized Command Center data.
3. Use the live Apps Script API for field editing where appropriate.

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

The online view should show enough signal to guide action and allow lightweight
field updates. Deeper detail can still live in Pulse, Procore, or the source
Google Sheet where appropriate.
