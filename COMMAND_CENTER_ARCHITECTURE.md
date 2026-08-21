# WPR Command Center Architecture And Sync Handoff

This document is a technical handoff for building a cleaner Procore API
extraction path. It explains where Command Center data lives today, how the
current syncs write into it, and what shape an API extractor should produce.

## Current Source Of Truth

The active Command Center is the online application backed by Cloudflare:

- Public site: `https://cknowlesati.github.io/WPR-Command-Center/`
- Live API Worker: `https://wpr-command-center-api.wpr-command-center.workers.dev`
- Worker source: `worker/src/index.js`
- D1 database: `wpr-command-center`
- Main UI source: `hosted-command-center/index.html`
- Root UI mirror: `index.html`

Legacy Google Apps Script files such as `Code.gs` are reference material only.
New source sync work should target the Cloudflare Worker/D1 path.

## High-Level Architecture

```text
Pulse / Procore sources
        |
        v
Local sync runners
  - pulse-sync/pulse-sync.js
  - procore-browser-sync/procore_browser_sync.js
  - run-morning-sync.ps1
        |
        v
Cloudflare D1 database: wpr-command-center
        |
        v
Cloudflare Worker API: worker/src/index.js
        |
        +--> Live Command Center UI
        |
        +--> Hosted fallback export
             hosted-command-center/data/projects.json
             data/projects.json
```

The live UI reads the Worker API first. The hosted JSON files are fallback
snapshots for static hosting and outages; they are not the primary database.

## Data Storage

Command Center data is stored in Cloudflare D1. The important tables for source
sync work are:

### `projects`

Project records shown in the dashboard.

Important fields:

- `id`
- `name`
- `project_group`
- `segment`
- `external_team`
- `percent`
- `starts_at`
- `ends_at`

External source items must be mapped to an existing `projects.id`, unless they
are intentionally sent to the Procore review bucket.

### `tasks`

This is where Pulse to-dos, Procore observations, and manual Command Center
tasks are stored.

Important fields:

- `id`: stable source task ID, text primary key.
- `project_id`: Command Center project ID.
- `name`: visible task/observation title.
- `status`: normalized Command Center status: `todo`, `progress`, or `done`.
- `source`: source key, usually `pulse`, `procore`, `procore-review`, or blank/manual.
- `source_state`: original source state, such as `Initiated` or `Ready For Review`.
- `external_url`: source detail URL.
- `due_date`: normalized `YYYY-MM-DD`, currently used by Pulse urgency.
- `priority`: normalized action signal.
- `assignee`: short assignee text.
- `source_updated_at`: source-side date/time or meaningful source date.
- `updated_by`: usually `SYNC` for source writes.
- `updated_at`: sync write timestamp.

The schema starts in `worker/migrations/0001_initial.sql`; source freshness is
added by `worker/migrations/0008_sync_runs.sql`; task signal fields are added by
`worker/migrations/0009_task_signal_fields.sql`.

### `sync_runs`

This powers the Pulse/Procore freshness indicators.

Important fields:

- `source`: `pulse` or `procore`.
- `label`: visible label.
- `status`: `success`, `failed`, `skipped`, or `unknown`.
- `last_attempt_at`
- `last_success_at`
- `records_seen`
- `records_written`
- `project_count`
- `message`
- `updated_at`
- `updated_by`

If a sync writes directly to D1, it must update this table. If it writes through
the Worker, use the `recordSyncRun` action or rely on `syncSourceTasks` where
appropriate.

## Worker API Contract

The Worker is implemented in `worker/src/index.js`.

### Read

`GET /` returns:

```json
{
  "ok": true,
  "data": [ /* projects */ ],
  "settings": {
    "sources": [ /* sync_runs status rows */ ]
  }
}
```

Each project includes a normalized `taskList` array. The UI uses this list to
display source tasks and compute attention signals.

### Write

Source syncs use:

```json
{
  "action": "syncSourceTasks",
  "source": "procore",
  "replaceProjectIds": ["1", "2"],
  "tasks": [
    {
      "id": "procore-2653585-123456",
      "projectId": "1",
      "name": "Procore #4204: Example observation title",
      "status": "todo",
      "sourceState": "Initiated",
      "externalUrl": "https://app.procore.com/...",
      "dueDate": "",
      "priority": "critical-aging",
      "assignee": "Name or company",
      "sourceUpdatedAt": "2026-07-01"
    }
  ]
}
```

Valid `source` values for synced tasks are:

- `pulse`
- `procore`
- `procore-review`

The Worker normalizes status and priority. It then replaces existing source
tasks for the listed `replaceProjectIds` and upserts the supplied `tasks`.

This replacement behavior is important: for Procore, closed observations should
be omitted from the active task list, and the project IDs they belonged to
should be included in `replaceProjectIds` so stale open rows are removed.

## Current Sync Runners

### Morning Orchestrator

`run-morning-sync.ps1` runs the source syncs.

Current behavior:

- Runs Pulse unless `-SkipPulse` is passed.
- Runs Procore unless `-SkipProcore` is passed.
- Retries each source step independently.
- Default retry pattern: 3 attempts, 5 minutes before attempt 2, 15 minutes
  before attempt 3.
- Procore can still run if Pulse fails, and Pulse can still run if Procore fails.

### Pulse Sync

`pulse-sync/pulse-sync.js` handles Pulse API to-dos and Pulse PM Contracts
timeline dates.

Current Pulse task rules:

- Only open ATI-related Pulse to-dos are synced.
- Lists for Solus, Solace, Linked, Sales, and Service are excluded.
- Completed Pulse to-dos are omitted so they drop out of Command Center.
- Pulse urgency is driven only by `due_date`.
- Pulse priority is not imported.

### Current Procore Browser Sync

`procore-browser-sync/procore_browser_sync.js` is the current production Procore
extractor. It uses a logged-in browser/CDP session to read observation list and
detail pages.

Current Procore command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" sync-auto --complete-missing --login-timeout 120000 --timeout 45000 --page-timeout 30000 --detail-timeout 45000 --detail-attempts 2 --attempts 2
```

The browser sync:

- Extracts observations from configured Procore observation URLs.
- Opens detail pages to confirm status, notification date, location, and description.
- Filters closed observations out of the active mapped task sync.
- Maps observations to Command Center projects.
- Sends unmatched observations to the Procore review bucket.
- Writes mapped tasks as source `procore`.
- Writes review tasks as source `procore-review`.
- Updates the `procore` row in `sync_runs`.

## Procore Observation Mapping Rules

The current browser sync expects a normalized Procore row with fields like:

- `project`: Procore project label/name.
- `procoreProjectId`: Procore project ID.
- `number`: observation number.
- `type`
- `title`
- `itemUrl`
- `detailUrl`
- `pdfUrl`
- `assignee`
- `assigneeCompany`
- `dateNotified`
- `createdBy`
- `dateCreated`
- `dueDate`
- `specSection`
- `status`
- `priority`
- `location`
- `description`

The function `buildProcoreTasks(rows, commandProjects)` maps these rows into
Command Center tasks.

### Project Mapping

Current project inference lives in `inferCommandProject(row, commandProjects)`.
It uses:

- Known Procore project IDs for special cases.
- Unit numbers inferred from `location`, `title`, and `description`.
- Condo rules for Penthouse, Unit 201/202, and Unit 101/102.

If no confident match is found, the observation is sent to the Procore review
bucket instead of being forced into a project.

### Task ID

Current task IDs are:

```text
procore-{procoreProjectId}-{itemId}
```

`itemId` comes from the Procore item URL when available; otherwise the
observation number is used.

An API extractor should preserve this ID pattern if possible. Stable IDs are
required so updates overwrite the existing observation instead of creating
duplicates.

### Status

Current status mapping:

- Procore `Closed` -> Command Center `done`.
- Procore `Ready For Review` -> Command Center `progress`.
- Procore `Initiated`, `Not Accepted`, `Work Required`, or unknown open states
  -> Command Center `todo`.

For the active Procore sync, closed observations should be omitted from `tasks`
and removed through `replaceProjectIds`.

### Priority / Action Signal

Command Center does not trust Procore's own priority labels because those are
set by Big-D. Instead it uses the observation status and notification age.

Current Procore priority rule:

- `Closed`: no priority, omitted from active sync.
- `Ready For Review`: no priority. This is informational because it is in
  Big-D's hands.
- `Initiated`, `Not Accepted`, `Work Required`:
  - 0 to 1 business day old: `new`
  - 2 to 3 business days old: `due-soon`
  - 4 to 7 business days old: `needs-action`
  - 8 or more business days old: `critical-aging`

The age is based on `dateNotified`.

### Review Bucket

Unmapped observations become tasks under the special project:

```text
Procore Observation Review
```

Review tasks use source `procore-review`. The Worker treats `procore-review` as
part of the Procore source family when replacing source rows.

## Recommended Procore API Integration Point

The cleanest API path is to replace only the extraction layer, not the Command
Center storage contract.

Recommended approach:

1. Build a Procore API extractor that returns the same normalized row shape
   currently produced by the browser extractor.
2. Reuse or port the existing functions:
   - `buildProcoreTasks`
   - `inferCommandProject`
   - `normalizeProcoreTask`
   - `normalizeProcoreReviewTask`
   - `commandCenterProcorePriority`
   - `syncToCommandCenter`
   - `syncProcoreReviewTasks`
3. Keep the outgoing Command Center payload the same:
   - `source: "procore"` for mapped observations.
   - `source: "procore-review"` for unmapped review observations.
   - `replaceProjectIds` containing all project IDs that should have stale
     Procore rows removed.
4. Keep updating `sync_runs` for `source: "procore"` with accurate counts.

This limits the risk: the UI, Worker, D1 schema, fallback export, and freshness
indicators can stay unchanged while the source extraction becomes cleaner.

## API Extractor Output Example

An API extractor can either pass normalized rows through the existing mapper or
emit final Command Center tasks directly. Prefer normalized rows first because
that keeps project mapping and priority behavior in one place.

Example normalized API row:

```json
{
  "project": "2653585 - WPR ...",
  "procoreProjectId": "2653585",
  "number": "4204",
  "type": "QC Field Observation",
  "title": "Example observation title",
  "itemUrl": "https://app.procore.com/2653585/project/observations/items/123456",
  "detailUrl": "https://app.procore.com/webclients/host/companies/9207/projects/2653585/tools/observations/quality/details/123456",
  "pdfUrl": "https://app.procore.com/2653585/project/observations/items/123456.pdf",
  "assignee": "ATI OF AMERICA",
  "assigneeCompany": "ATI OF AMERICA",
  "dateNotified": "2026-07-01",
  "createdBy": "Big-D User",
  "dateCreated": "2026-07-01",
  "dueDate": "",
  "specSection": "",
  "status": "Initiated",
  "priority": "",
  "location": "Building>Unit 202>...",
  "description": "Observation description..."
}
```

Example final Command Center task:

```json
{
  "id": "procore-2653585-123456",
  "projectId": "4",
  "name": "Procore #4204: Example observation title",
  "status": "todo",
  "sourceState": "Initiated",
  "externalUrl": "https://app.procore.com/webclients/host/companies/9207/projects/2653585/tools/observations/quality/details/123456",
  "dueDate": "",
  "priority": "critical-aging",
  "assignee": "ATI OF AMERICA",
  "sourceUpdatedAt": "2026-07-01"
}
```

## Fallback Hosted Data

The fallback snapshot is generated by:

```text
hosted-command-center/tools/export-hosted-data.mjs
```

GitHub Actions workflow:

```text
.github/workflows/hosted-command-center-pages.yml
```

The workflow refreshes hosted JSON from the Worker, mirrors it to root
`data/projects.json`, validates it, and deploys Pages. Source syncs should not
write to these JSON files directly. They should write D1/Worker first, then the
fallback export should regenerate from the live API.

## Security And Secrets

Do not commit real `.env` files.

Relevant local secret files:

- `pulse-sync/.env`
- `procore-browser-sync/.env`

Expected write credentials:

- `COMMAND_CENTER_ACCESS_CODE`, or
- `COMMAND_CENTER_SESSION`, or
- Cloudflare/Wrangler credentials for direct D1 writes.

For a Procore API integration, prefer a dedicated Procore service account or
OAuth/API credential path rather than browser session reuse. The output should
still flow into the same Command Center sync contract.

## Practical Handoff Summary For The API Agent

The API agent does not need to redesign Command Center storage. It should:

1. Pull Procore observations from the API.
2. Normalize them into the current Procore row shape.
3. Keep closed observations out of the active mapped task list.
4. Preserve stable IDs: `procore-{procoreProjectId}-{itemId}`.
5. Use the current status and priority rules.
6. Map observations to existing Command Center project IDs.
7. Send unmapped observations to the Procore review bucket.
8. Write through `syncSourceTasks` or the existing direct-D1 helper.
9. Update the `procore` row in `sync_runs`.
10. Let the hosted fallback export refresh from the Worker afterward.
