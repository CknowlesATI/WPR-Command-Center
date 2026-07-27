# Procore API Sync Probe

This is the Path 1 test harness: it checks whether Command Center can extract observations directly from Procore's official API.

It does not sync data into Command Center yet.

## Setup

Copy `.env.example` to `.env` in this folder and fill in either:

- `PROCORE_ACCESS_TOKEN` for a quick short-lived probe, or
- `PROCORE_CLIENT_ID` and `PROCORE_CLIENT_SECRET` from an approved Procore app/service account.

Once a company is known, set `PROCORE_COMPANY_ID`.

## Test Sequence

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-api-sync\run-procore-api-sync.ps1" env-check
```

Then:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-api-sync\run-procore-api-sync.ps1" auth-test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-api-sync\run-procore-api-sync.ps1" companies
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-api-sync\run-procore-api-sync.ps1" projects --company-id 12345
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-api-sync\run-procore-api-sync.ps1" observations --company-id 12345 --project-id 67890
```

## Pass Criteria

Path 1 is viable if:

1. Auth succeeds.
2. Companies/projects are visible.
3. `observations` returns Quality Observation items for an ATI project.
4. Returned fields include enough signal: number/title, status, assignee, type, due date, location, and description.

If auth requires admin-approved app credentials that we cannot get, Path 1 is considered blocked and we move to browser-assisted extraction.
