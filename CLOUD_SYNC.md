# Independent source syncing

The hosted workflow is `.github/workflows/cloud-source-sync.yml`. It uses
GitHub-hosted Ubuntu for Pulse and GitHub-hosted Windows/Chrome for Procore.
Neither job uses this computer, its browser profile, Codex runtime, local task
scheduler, or locally authenticated Wrangler session.

## Activation gate

Automatic collectors are enabled as of September 22, 2026. The repository variable
`CLOUD_SYNC_ENABLED` is exactly `true`. Manual workflow runs default to
`verify`, which reads sources and maps observations without writing data or
freshness status. Do not enable the variable until both verification and live
sync have passed on the hosted runners. The ChatGPT cloud browser trial proved
one-project extraction, not this workflow or recurring login reliability.

Required encrypted repository secrets:

- `PULSE_EMAIL`, `PULSE_PASSWORD`
- `PROCORE_EMAIL`, `PROCORE_PASSWORD`, `PROCORE_COMPANY_ID`,
  `PROCORE_OBSERVATIONS_URLS` (all five configured Procore project URLs)
- `COMMAND_CENTER_SYNC_TOKEN`: a new random token of at least 32 characters,
  matching the Worker's `SYNC_TOKEN` secret.

Christen explicitly authorized encrypted credential transfer and cloud tests on
September 22, 2026. The secrets above are installed; the Worker uses a dedicated
sync-only token. Never commit credentials, browser profiles, raw source extracts,
or sensitive page text. Workflow logs contain counts and run status only.
Trusted workflow modifications can access the repository secrets.

## Behavior

The cloud scheduler is configured for minutes 17 and 47 each hour. It runs a source if
requested from Command Center or if the last success is at least six hours old.
Failed sources retry at most hourly. Pulse and Procore use separate jobs so one
failure does not suppress the other. A single concurrency group prevents two
hosted sync workflows overlapping. Observed GitHub scheduling delays on September
22–23 were several hours, so neither the check interval nor the six-hour refresh
threshold is a guaranteed turnaround time. The UI reports requests as queued
until a real success is recorded. Public
repository schedules can be disabled after 60 days without repository activity.
Source freshness in Command Center must remain the authority for actual data
age, not a successful website publication.

The dedicated cloud token permits only source task/timeline/contract updates,
source status recording, and creation of the fixed Procore review bucket. It
cannot edit manual tasks, close projects, or change notification settings.
Cloud jobs cannot fall back to direct D1 writes. Source freshness advances only
after the collector records final success, then the hosted wrapper checks the
live endpoint for a new `CLOUD` success timestamp.

Procore requires explicit list counts and complete pagination for every
configured source project. Missing pages, unknown counts, missing statuses,
duplicate links, oversized payloads, and empty extracts fail safely. Mapped and
unmapped Procore tasks are written in one database batch. Truly empty source
projects currently require investigation; they are not automatically treated as
permission to delete prior data. Missing location information is routed to the
review bucket instead of guessed.

## Acceptance sequence

1. Run `node --test tools/cloud-sync.test.mjs` and the existing validations.
2. Deploy the Worker changes and check public reads and unauthorized writes.
3. After credential-transfer approval, install secrets using encrypted APIs.
4. Manually run the workflow with `mode=verify`, first for each source, then both.
5. Compare extracted source counts/IDs and project mappings against live data.
6. Run `mode=sync` and confirm new `CLOUD` timestamps and preserved manual data.
7. Repeat with a fresh hosted browser profile to test unattended login.
8. Enable the schedule, queue source requests, and verify scheduled pickup.
9. Confirm a scheduled run while the local runner is disabled; retain rollback
   instructions and record the cloud run URLs before retiring the local task.

The local Windows task `WPR Pulse Sync` is disabled following successful cloud
verification and live writes. Timer-driven acceptance passed on September 23.
The Codex heartbeat `weekly-pulse-timeline-sync-check` (Weekly Source Sync Check)
is also paused so it cannot launch a competing local source write.

## Verified results (September 22–23, 2026)

- All 16 cloud safeguards tests, control rules, and hosted data validation pass.
- Pulse read-only hosted verification: run `35727187431` passed.
- Pulse live hosted sync: run `35728067955` passed. The live API confirmed
  `CLOUD` success at `2026-09-22T12:37:59.712Z`, 655 records across 21 projects.
  All 10 manual items were unchanged.
- Procore read-only hosted verification: run `35729097924` passed. It read all
  149 observations across five source lists (79, 43, 13, 10, and 4).
- Procore live hosted sync with observation identity checks: run `35729965697`
  passed on a fresh hosted browser. The live API confirmed `CLOUD` success at
  `2026-09-22T13:05:56.890Z`, 24 open ATI observations (7 mapped, 17 retained in
  the review bucket). Manual content was unchanged.
- Both sources were queued for automatic acceptance with the local Windows
  sync task disabled. Scheduled run
  [35759817264](https://github.com/CknowlesATI/WPR-Command-Center/actions/runs/35759817264)
  passed after picking up the requests. The queue was set through the backend
  for this test; no interactive editor login was required.
- Repeated scheduled run
  [35859195011](https://github.com/CknowlesATI/WPR-Command-Center/actions/runs/35859195011)
  passed both hosted collectors on September 23. Pulse confirmed 656 records
  across 21 projects at `2026-09-23T12:14:44.538Z`. Procore confirmed all five
  complete lists and 24 open ATI records at `2026-09-23T12:21:09.909Z`.
- Corrected project mapping now places 19 Procore items into specific projects.
  Five remain in the review bucket because the source does not establish a
  specific unit confidently. Explicit child unit locations take precedence over
  parent building ranges; building and floor numbers alone are never unit IDs.
- All 10 manual items remained identical to the pre-cutover baseline after the
  overnight scheduled runs. The Windows task was confirmed disabled again.

## Rollback and operations

Set `CLOUD_SYNC_ENABLED=false` to stop scheduled collectors (the selection job
will still run without secrets). Revoke `SYNC_TOKEN` to prevent cloud writes.
Manual dispatch is available for diagnosis. Do not run local and hosted writers
simultaneously during cutover. Review failed Actions runs and Command Center
source freshness; Procore MFA/SSO challenges may require interactive intervention
or migration to official API access.

To restore the prior local schedule after stopping cloud collectors, run
`Enable-ScheduledTask -TaskName 'WPR Pulse Sync'` on the original Windows host.
This rollback requires that host to remain available. The pre-cutover database
backup is kept locally in ignored `tmp/cloud-precutover.sql`.
