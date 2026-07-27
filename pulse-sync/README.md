# Pulse Sync CLI

This local CLI syncs Pulse to-dos into the Project Command Center Google Sheet backend.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in your Pulse email, Pulse password, and Command Center Apps Script URL.
3. Optional: copy `project-map.example.json` to `project-map.json` if Pulse project names do not exactly match Command Center project names.

## Commands

From the repository root:

```powershell
npm run pulse:login-test
npm run pulse:dry-run
npm run pulse:sync
npm run pulse:search-projects -- WPR
```

If `npm` is not available on this computer, use the PowerShell runner instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\pulse-sync\run-pulse-sync.ps1" -Command dry-run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\pulse-sync\run-pulse-sync.ps1" -Command sync
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\pulse-sync\run-pulse-sync.ps1" -Command search-projects WPR
```

`dry-run` fetches Pulse and Command Center data, matches projects, and reports what would be created or updated without changing the Google Sheet.

`sync` sends the normalized Pulse tasks to the Command Center backend using the `syncExternalTasks` action.

## Scheduling

After a successful dry run and sync, create a Windows Task Scheduler job that runs:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repo path>\pulse-sync\run-pulse-sync.ps1"
```
