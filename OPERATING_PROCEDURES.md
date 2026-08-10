# Command Center Operating Procedures

## Default Work Target

The active Command Center product is the online version in
`hosted-command-center`.

The original Google Apps Script command center at the repository root is a
legacy/reference implementation. Use it as a source for proven workflow ideas
and API behavior, but do not maintain it as a separate long-term user
experience unless Christen explicitly asks for that.

## Version Map

Online Command Center:

- App files: `hosted-command-center/`
- Main page: `hosted-command-center/index.html`
- Published data: `hosted-command-center/data/projects.json`
- Data export: `hosted-command-center/tools/export-hosted-data.mjs`
- Validation: `hosted-command-center/tools/validate-hosted-data.mjs`
- Intended publishing path: GitHub Pages workflow
- Live data/editing path: Google Sheet through the Apps Script web app URL

Legacy/root Command Center:

- Main page: `index.html`
- Apps Script backend: `Code.gs`
- Data source: Google Sheet through the Apps Script web app URL
- Use: reference implementation and Apps Script API source

## Before Making Changes

1. Confirm which version is affected by the request.
2. Default to `hosted-command-center/` when the request is ambiguous.
3. Pull needed workflow features forward into the hosted app instead of
   expanding the legacy/root app.
4. State clearly when a change needs to touch the Apps Script API in `Code.gs`.

## Verification

For online Command Center changes:

- Check the affected files under `hosted-command-center/`.
- Validate `hosted-command-center/data/projects.json` when the static snapshot
  contract changes.
- Preview or publish through the hosted workflow when requested.
- If live editing changes, verify the corresponding Apps Script API action in
  `Code.gs`.

For Apps Script API changes:

- Check `Code.gs`.
- Push `Code.gs` with clasp when backend code changes.
- Create or update the Apps Script deployment version before expecting the live
  online Command Center to receive backend behavior changes.
