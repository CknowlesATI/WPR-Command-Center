# Cloudflare Database Handoff

The Command Center now has a Cloudflare D1 database and Worker API path.

## Live API

- Worker: `wpr-command-center-api`
- URL: `https://wpr-command-center-api.wpr-command-center.workers.dev`
- D1 database: `wpr-command-center`
- D1 database ID: `27f45859-7060-4c1b-96ca-809fc7d7e058`

## Data Flow

1. The static Command Center website loads from GitHub Pages.
2. The website reads project data from the Cloudflare Worker.
3. The Worker reads and writes Cloudflare D1.
4. The old Google Apps Script and Google Sheet path can remain as a temporary backup during the transition.

## Project Commands

```powershell
pnpm d1:seed
pnpm cf:migrate
pnpm cf:deploy
```

`pnpm d1:seed` exports the current Apps Script data into
`worker/migrations/0002_seed_current_data.sql`. Use this only when intentionally
re-seeding the D1 database from the old source.

## Cost Notes

The current data size is well inside Cloudflare's free D1 and Workers limits.
This setup avoids a paid database subscription for normal Command Center usage.

## Write Access

The Worker supports an optional `WRITE_TOKEN` secret. If that secret is set in
Cloudflare, write requests must include the matching `x-command-center-token`
header. The public website does not require that token yet, so the current live
behavior matches the previous Apps Script setup.
