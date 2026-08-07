# Command Center Operating Procedures

## Default Work Target

Unless Christen explicitly says otherwise, focus all Command Center work on the
online/shared version in `hosted-command-center`.

The original Google Apps Script command center at the repository root should be
treated as a legacy/internal baseline. Do not change it for routine online
dashboard work unless the request specifically names the original version, the
Google Sheet, Apps Script, or live API behavior.

## Version Map

Online/shared Command Center:

- App files: `hosted-command-center/`
- Main page: `hosted-command-center/index.html`
- Published data: `hosted-command-center/data/projects.json`
- Data export: `hosted-command-center/tools/export-hosted-data.mjs`
- Validation: `hosted-command-center/tools/validate-hosted-data.mjs`
- Intended publishing path: GitHub Pages workflow

Original/internal Command Center:

- Main page: `index.html`
- Apps Script backend: `Code.gs`
- Data source: Google Sheet through the Apps Script web app URL
- Deployment: clasp push plus a new Apps Script web app deployment version

## Before Making Changes

1. Confirm which version is affected by the request.
2. Default to `hosted-command-center/` when the request is ambiguous.
3. State when a change needs to touch the original/internal command center.
4. Keep online/shared dashboard changes separate from original/internal changes
   unless Christen asks for both.

## Verification

For online/shared changes:

- Check the affected files under `hosted-command-center/`.
- Validate `hosted-command-center/data/projects.json` when data changes.
- Preview or publish through the hosted workflow when requested.

For original/internal changes:

- Check `index.html` and/or `Code.gs`.
- Push `Code.gs` with clasp when backend code changes.
- Create or update the Apps Script deployment version before expecting the live
  web app URL to change.
