# Hosted Command Center

This folder is the source copy for the online version of Project Command
Center. It is the intended field-facing Command Center experience.

Unless Christen explicitly specifies otherwise, this online version is the
default target for Command Center work. See `../OPERATING_PROCEDURES.md` before
changing legacy Apps Script behavior.

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

- `index.html` is the source dashboard shell. Mirror changes to root
  `../index.html`, which is served by GitHub Pages.
- It loads live data from the Cloudflare Worker API when available.
- `data/projects.json` is the fallback data file the hosted dashboard loads
  when live data is unavailable.
- `data/projects.sample.json` is the example data contract for future sync work.
- `tools/export-hosted-data.mjs` converts current Command Center API data into
  the safer hosted fallback data shape.
- `tools/validate-hosted-data.mjs` checks that hosted data follows the shared
  fallback contract.
- `run-preview.ps1` starts a local preview for this hosted folder.
- `DATA_CONTRACT.md` documents the safe shared data shape.

The current dashboard uses the Cloudflare Worker and D1 database for live data
and editing. Static JSON remains as a fallback snapshot.

## No-Subscription Hosting Path

The intended first hosting path is GitHub Pages, Cloudflare Pages, Netlify, or
Vercel free tier. No custom domain is required.

The current no-subscription hosting path is:

1. Serve root `index.html` through GitHub Pages.
2. Keep `hosted-command-center/index.html` mirrored to root `index.html`.
3. Use the Cloudflare Worker API and D1 database for live field editing.

The repository's `main` branch is the public GitHub Pages publishing path.

## Fallback Data Export

The hosted fallback data file can still be generated from an older Command
Center API when a static snapshot is needed:

```powershell
node hosted-command-center/tools/export-hosted-data.mjs --url "<Apps Script URL>"
```

Or by setting `COMMAND_CENTER_API_URL` before running the script.

By default, the export does not include task notes, raw external IDs, or source
links. Source links can be added later with `--include-links` only after the
links are reviewed and considered safe for the intended audience.

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
field updates. Deeper detail can still live in Pulse, Procore, or the relevant
source system where appropriate.
