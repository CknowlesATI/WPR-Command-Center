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

Write access is protected by Cloudflare Worker secrets:

- `ACCESS_CODE`: shared code that approved users enter once per browser/device.
- `SESSION_SECRET`: private signing secret used by the Worker to verify saved
  browser sessions.

The website stores a roughly 6-month edit session in the user's browser after
the access code is accepted. Future edits send that session token in the
background, so the user does not need to enter the code every time.

The access code is intentionally not stored in this repository. Rotate it from
Cloudflare/Wrangler when needed:

```powershell
pnpm exec wrangler secret put ACCESS_CODE --config worker/wrangler.toml
```

Task and project-control edits store the editor initials and timestamp so the
Command Center can show a small "Last edit CK" note.
