# Independent source syncing

The hosted workflow is `.github/workflows/cloud-source-sync.yml`. It uses
GitHub-hosted Ubuntu for Pulse and GitHub-hosted Windows/Chrome for Procore.
Neither job uses this computer, its browser profile, Codex runtime, local task
scheduler, or locally authenticated Wrangler session.

## Activation gate

Automatic collectors are disabled unless the repository variable
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

The cloud scheduler checks at minutes 17 and 47 each hour. It runs a source if
requested from Command Center or if the last success is at least six hours old.
Failed sources retry at most hourly. Pulse and Procore use separate jobs so one
failure does not suppress the other. A single concurrency group prevents two
hosted sync workflows overlapping. GitHub scheduling can be delayed; public
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
8. Enable the schedule and test a Command Center Request Sync end to end.
9. Confirm a scheduled run while the local runner is disabled; retain rollback
   instructions and record the cloud run URLs before retiring the local task.

Until those steps pass, the migration is not complete and the existing local
runner remains the operational fallback. Do not describe this staged workflow
as an active replacement.

## Verified results (September 22, 2026)

- All 14 cloud safeguards tests, control rules, and hosted data validation pass.
- Pulse read-only hosted verification: run `35727187431` passed.
- Pulse live hosted sync: run `35728067955` passed. The live API confirmed
  `CLOUD` success at `2026-09-22T12:37:59.712Z`, 655 records across 21 projects.
  All 10 manual items were unchanged.
- Procore hosted verification is still in progress. Automatic source collectors
  remain disabled pending full Procore validation and schedule acceptance.

## Rollback and operations

Set `CLOUD_SYNC_ENABLED=false` to stop scheduled collectors (the selection job
will still run without secrets). Revoke `SYNC_TOKEN` to prevent cloud writes.
Manual dispatch is available for diagnosis. Do not run local and hosted writers
simultaneously during cutover. Review failed Actions runs and Command Center
source freshness; Procore MFA/SSO challenges may require interactive intervention
or migration to official API access.
