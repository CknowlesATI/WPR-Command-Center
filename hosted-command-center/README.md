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

## Data Safety Rules

Before using real data online, remove or avoid exposing:

- Private Pulse notes that should not be broadly visible.
- Sensitive Procore links or attachment URLs.
- Credentials, internal IDs, and sync details.
- Financial, contractual, personnel, or access-sensitive details.

The public/shared view should show enough signal to guide action, then send the
tech back to Pulse or Procore only when deeper work is needed.
