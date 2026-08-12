param(
  [switch]$SkipPulse,
  [switch]$SkipProcore,
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$LogFile = Join-Path $LogDir "morning-sync-$Stamp-$PID.log"
$Failures = 0

function Run-Step {
  param(
    [string]$Name,
    [scriptblock]$Script
  )
  "===== $Name started $(Get-Date -Format s) =====" | Tee-Object -FilePath $LogFile -Append
  try {
    & $Script *>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) {
      "===== $Name failed with exit code $LASTEXITCODE =====" | Tee-Object -FilePath $LogFile -Append
      $script:Failures += 1
    } else {
      "===== $Name completed =====" | Tee-Object -FilePath $LogFile -Append
    }
  } catch {
    "===== $Name failed: $($_.Exception.Message) =====" | Tee-Object -FilePath $LogFile -Append
    $script:Failures += 1
  }
}

Set-Location $RepoRoot

if (-not $SkipPulse) {
  Run-Step "Pulse sync" {
    $PulseCommand = if ($DryRun) { "dry-run" } else { "sync" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\pulse-sync\run-pulse-sync.ps1" -Command $PulseCommand
  }
}

if (-not $SkipProcore) {
  Run-Step "Procore observation sync" {
    $ProcoreCommand = if ($DryRun) { "env-check" } else { "sync-auto" }
    $PowerShell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
    if ($DryRun) {
      & $PowerShell -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" $ProcoreCommand
    } else {
      & $PowerShell -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" $ProcoreCommand --complete-missing --login-timeout 120000
    }
  }
}

"===== Morning sync finished $(Get-Date -Format s). Failures: $Failures =====" | Tee-Object -FilePath $LogFile -Append

if ($Failures -gt 0) {
  exit 1
}
