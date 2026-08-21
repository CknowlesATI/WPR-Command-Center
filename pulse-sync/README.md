# Pulse / Procore Source Sync

This folder restores the source-sync runner referenced by `package.json`.

Pulse has usable internal JSON endpoints for project to-dos and PM Contracts
schedule dates. This runner keeps one clean Command Center sync path for:

- Pulse to-dos from the Pulse login/API path.
- Pulse PM Contracts timeline dates from the Pulse API.
- Pulse PM dashboard timeline dates from an extracted table when explicitly
  provided.
- Pulse to-dos from a table/JSON file when API extraction is not desired.
- Procore observations when exported/copied into a table or JSON file.

## Commands

```powershell
pnpm pulse:dry-run -- --pulse-timeline-file .\tmp\pulse-wpr.tsv
pnpm pulse:dry-run -- --pulse-timeline-api --no-pulse-todos
pnpm pulse:sync -- --pulse-timeline-file .\tmp\pulse-wpr.tsv
pnpm pulse:sync -- --pulse-timeline-api
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
- Pulse API to-dos only sync open ATI-related items. Lists for Solus, Solace,
  Linked, Sales, and Service are excluded; completed Pulse to-dos are omitted
  so they drop out of Command Center on the next project-scoped task sync.
- Pulse API to-do urgency is driven only by `due_date`. Pulse priorities are not
  imported, and open Pulse to-dos without a due date remain informational.
- Synced Pulse and Procore tasks remain read-only inside Command Center.
- Task sync replaces items for the source and project scope included in the
  run, then upserts the extracted items.

## Morning Runner Date Cadence

`run-morning-sync.ps1` runs Pulse to-dos every time it runs. It also checks
whether Pulse timeline dates are due for refresh. By default, timeline dates
sync daily from the Pulse PM Contracts API.

Useful options:

```powershell
.\run-morning-sync.ps1 -ForcePulseTimeline
.\run-morning-sync.ps1 -PulseTimelineCadenceDays 14
.\run-morning-sync.ps1 -PulseTimelineFile .\tmp\pulse-wpr-timeline-2026-08-13.json
.\run-morning-sync.ps1 -SkipPulseTimeline
```

`-PulseTimelineFile` overrides the API source for that run.

The cadence state is written to `logs/pulse-timeline-sync-state.json` after a
successful non-dry-run timeline sync.
