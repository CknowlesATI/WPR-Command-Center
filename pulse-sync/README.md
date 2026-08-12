# Pulse / Procore Source Sync

This folder restores the source-sync runner referenced by `package.json`.

Pulse has usable internal JSON endpoints for project to-dos, but the PM
Contracts schedule dates are currently only verified through the dashboard
table. This runner keeps one clean Command Center sync path for:

- Pulse to-dos from the Pulse login/API path.
- Pulse PM dashboard timeline dates from an extracted table.
- Pulse to-dos from a table/JSON file when API extraction is not desired.
- Procore observations when exported/copied into a table or JSON file.

## Commands

```powershell
pnpm pulse:dry-run -- --pulse-timeline-file .\tmp\pulse-wpr.tsv
pnpm pulse:sync -- --pulse-timeline-file .\tmp\pulse-wpr.tsv
pnpm pulse:sync -- --pulse-timeline-file .\tmp\pulse-wpr.tsv --pulse-todos-file .\tmp\pulse-todos.tsv --procore-observations-file .\tmp\procore-observations.tsv
pnpm pulse:search-projects -- WPR
pnpm pulse:login-test
```

For Pulse API to-dos, set:

- `PULSE_EMAIL`
- `PULSE_PASSWORD`

For Command Center `sync`, set one of:

- `COMMAND_CENTER_ACCESS_CODE`
- `COMMAND_CENTER_SESSION`

Optional:

- `COMMAND_CENTER_INITIALS`, defaults to `SYNC`.
- `COMMAND_CENTER_API_URL`, defaults to the live Cloudflare Worker.
- `--no-pulse-todos`, for date-only dry runs or syncs.

## Expected Inputs

Timeline input should come from the Pulse PM Contracts dashboard filtered to
WPR rows:

`https://www.pulsecentral.ai/c/ati-of-america/pm-contracts/ati/dashboard`

The runner accepts TSV, CSV, or JSON rows. For dates, the important columns are:

- `Customer`
- `Prewire Schedule`
- `Prewire Date`
- `Trim Schedule`
- `Trim Date`
- `Install Schedule`
- `Install Date`
- `Add to ATI`

Task/observation input accepts TSV, CSV, or JSON rows with these preferred
columns:

- `Project` or `Customer`
- `Title`, `Task`, `To-Do`, `Observation`, or `Description`
- `Id`, `Task Id`, `Observation Id`, or `Number`
- `Status` or `State`
- `Source State`, `Pulse Status`, `Procore Status`, or `Ball In Court`
- `Url`, `Link`, or `External Url`

## Behavior

- Command Center project matching uses WPR unit/condo naming rules plus exact
  project name matching for known non-unit projects such as Skier Services, D4,
  and D35.
- Pulse timeline dates update `prewire`, `trim`, and `install` timeline date
  fields only.
- Timeline phase/status checkmarks are not overwritten.
- Synced Pulse and Procore tasks remain read-only inside Command Center.
- Task sync replaces items for the source and project scope included in the
  run, then upserts the extracted items.
