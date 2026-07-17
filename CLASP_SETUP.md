# Clasp Setup

This repo keeps the GitHub Pages frontend in `index.html` and the Google Sheets Apps Script backend in `Code.gs`.

## One-time local setup

1. Install project dependencies:

   ```powershell
   $env:PATH='C:\Users\Christen Knowles\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
   & 'C:\Users\Christen Knowles\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' install
   ```

2. Log in to Google:

   ```powershell
   .\apps.ps1 login
   ```

3. In the bound Apps Script project, open Project Settings and copy the Script ID.

4. Copy `.clasp.example.json` to `.clasp.json`, then replace the placeholder with that Script ID.

## Everyday workflow

After editing `Code.gs` in this repo:

```powershell
.\apps.ps1 push
```

Then open Apps Script and create a new Web App deployment version. Apps Script deployments are snapshots, so pushing code alone does not update the live Web App URL.

To open the linked Apps Script project:

```powershell
.\apps.ps1 open
```

## Safety notes

- `Code.gs` is intended to be the source of truth.
- `.clasp.json` is ignored because it points to one specific Apps Script project.
- `.claspignore` makes sure `index.html` is not pushed into Apps Script.
- `seedData()` deletes and recreates the data tabs. Do not run it after real project data exists unless you intentionally want to reset the Sheet.
