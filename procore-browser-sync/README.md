# Procore Browser Sync Probe

This is the Path 2 test harness: extract Procore Quality Observations from a normal logged-in browser session instead of asking someone to download PDFs manually.

## Current Test Result

Using the logged-in Procore project page:

```text
https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality
```

The browser extraction found:

```text
Project: 824117 - WPR NORTH VILLAGE 5-PLEX BUILDING ONE
Rows visible in Procore: 32
Rows extracted: 32
Open ATI rows extracted: 6
PDF links available from page: 32
Detail links available from page: 32
```

Review outputs from the probe are written to:

```text
procore-browser-sync/output/procore-browser-observations.csv
procore-browser-sync/output/procore-browser-observations.json
```

## Extraction Framework

1. Reuse a logged-in Procore browser session.
2. Navigate directly to each project Quality Observations list.
3. Read the visible page data and item/detail/PDF links.
4. Parse rows using the page's own observation links as anchors.
5. Filter to ATI-owned and non-closed observations.
6. Write CSV/JSON review files.
7. Later, sync approved rows to Command Center using stable source tracking.

## Why This Path Is Better Than Manual PDFs

The Quality Observations list already exposes all fields needed for the Command Center signal:

- Observation number
- Type
- Title
- Assignee
- Assignee company
- Date notified
- Created by
- Date created
- Due date
- Status
- Priority
- Location
- Description
- Procore detail link
- Procore PDF link

This means the CLI can collect the data directly from Procore after login, without requiring someone to export PDFs.

## Remaining Vetting

Before using this for unattended sync, test the same extraction against:

1. Another ATI project with more than one page of observations.
2. A project with no observations.
3. A project where filters are already applied.
4. A project where Procore requires re-login or MFA.

If those pass, this becomes the preferred path unless official API credentials become available.

## Fully Automated Credential Test

Create `procore-browser-sync/.env` from `.env.example` and fill in:

```text
PROCORE_EMAIL=
PROCORE_PASSWORD=
PROCORE_COMPANY_ID=9207
PROCORE_OBSERVATIONS_URL=https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality
```

Check the private config:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" env-check
```

Run a fully automated extraction attempt:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" extract-auto --ati-only --open-only
```

The automated extractor now treats status capture as required. It reads the
current Procore list layout, opens each observation detail page to confirm the
actual Procore status, and retries slow browser/detail reads before failing.
This prevents a blank or partially rendered Procore page from being accepted as
"no observations" and clearing Command Center rows.

Recommended guarded extraction command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" extract-auto --ati-only --open-only --login-timeout 120000 --timeout 45000 --page-timeout 30000 --detail-timeout 45000 --detail-attempts 2 --attempts 2
```

Use `--allow-empty` only after manually verifying that the Procore project truly
has no observation rows. Use `--allow-missing-status` only for investigation;
normal syncs should fail if any extracted observation is missing a Procore
status.

This is only viable if Procore accepts username/password login without MFA, verification, SSO handoff, or CAPTCHA. If Procore requires MFA, this path is blocked for unattended automation and the next viable path is official API/service-account access from the Procore-owning company.

## Persistent Login Test

The local CLI uses a dedicated browser profile at:

```text
procore-browser-sync/.browser-profile
```

First run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" open-login
```

Complete login in the browser window that opens, then close that browser window.

For the attach-based test, leave the browser window open and check whether the CLI can see the logged-in session:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" login-check-cdp
```

For the persistent-profile launch test, close the browser window and check whether the saved session works:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" login-check
```

A successful result should show:

```json
{
  "authenticated": true
}
```

After that, later CLI runs should reuse the same Procore browser session until Procore expires it. Keep the dedicated Procore browser window closed before running extraction so the profile is not locked.

Extract one project after login is working:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" extract-cdp --ati-only --open-only --url "https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality"
```
