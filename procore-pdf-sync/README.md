# Procore PDF Sync Test CLI

This local test parser reads Procore Observations PDF exports and writes review files. It does not update the Command Center backend yet.

## Run Against A PDF

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-pdf-sync\run-procore-pdf-sync.ps1" "C:\Path\To\observations.pdf"
```

Outputs are written to:

```text
procore-pdf-sync/output/procore-observations-review.csv
procore-pdf-sync/output/procore-observations-review.json
```

## Useful Filters

Only ATI-assigned rows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-pdf-sync\run-procore-pdf-sync.ps1" --ati-only "C:\Path\To\observations.pdf"
```

Only open rows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-pdf-sync\run-procore-pdf-sync.ps1" --open-only "C:\Path\To\observations.pdf"
```

Only open ATI-assigned rows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\procore-pdf-sync\run-procore-pdf-sync.ps1" --ati-only --open-only "C:\Path\To\observations.pdf"
```

## Notes

The bulk PDF layout is compact and can split observation fields across pages. Treat the CSV as a review artifact until a few more exports have been checked.
