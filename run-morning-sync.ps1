param(
  [switch]$SkipPulse,
  [switch]$SkipPulseTimeline,
  [switch]$SkipProcore,
  [switch]$DryRun,
  [switch]$ForcePulseTimeline,
  [int]$PulseTimelineCadenceDays = 1,
  [string]$PulseTimelineFile = "",
  [int]$StepRetryCount = 3,
  [int]$StepRetryDelaySeconds = 300,
  [int]$StepRetryBackoffSeconds = 600
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$LogFile = Join-Path $LogDir "morning-sync-$Stamp-$PID.log"
$PulseTimelineStateFile = Join-Path $LogDir "pulse-timeline-sync-state.json"
$Failures = 0

function Run-Step {
  param(
    [string]$Name,
    [scriptblock]$Script,
    [int]$RetryCount = $StepRetryCount,
    [int]$RetryDelaySeconds = $StepRetryDelaySeconds,
    [int]$RetryBackoffSeconds = $StepRetryBackoffSeconds
  )

  $Attempts = [Math]::Max(1, $RetryCount)
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt += 1) {
    "===== $Name attempt $Attempt/$Attempts started $(Get-Date -Format s) =====" | Tee-Object -FilePath $LogFile -Append
    try {
      $global:LASTEXITCODE = 0
      & $Script *>&1 | Tee-Object -FilePath $LogFile -Append
      if ($LASTEXITCODE -eq 0) {
        "===== $Name completed on attempt $Attempt/$Attempts =====" | Tee-Object -FilePath $LogFile -Append
        return $true
      }

      "===== $Name attempt $Attempt/$Attempts failed with exit code $LASTEXITCODE =====" | Tee-Object -FilePath $LogFile -Append
    } catch {
      "===== $Name attempt $Attempt/$Attempts failed: $($_.Exception.Message) =====" | Tee-Object -FilePath $LogFile -Append
    }

    if ($Attempt -lt $Attempts) {
      $DelaySeconds = [Math]::Max(0, $RetryDelaySeconds + (($Attempt - 1) * $RetryBackoffSeconds))
      if ($DelaySeconds -gt 0) {
        "===== $Name retrying in $DelaySeconds second(s) =====" | Tee-Object -FilePath $LogFile -Append
        Start-Sleep -Seconds $DelaySeconds
      } else {
        "===== $Name retrying immediately =====" | Tee-Object -FilePath $LogFile -Append
      }
    }
  }

  "===== $Name failed after $Attempts attempt(s) =====" | Tee-Object -FilePath $LogFile -Append
  $script:Failures += 1
  return $false
}

function Resolve-PulseTimelineFile {
  param([string]$ExplicitPath)

  if ($ExplicitPath) {
    $resolved = Resolve-Path $ExplicitPath -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
    return ""
  }

  $latest = Get-ChildItem -Path (Join-Path $RepoRoot "tmp") -Filter "pulse-wpr-timeline-*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($latest) { return $latest.FullName }
  return ""
}

function Test-PulseTimelineDue {
  if ($ForcePulseTimeline) { return $true }
  if ($PulseTimelineCadenceDays -le 0) { return $true }
  if (-not (Test-Path $PulseTimelineStateFile)) { return $true }

  try {
    $state = Get-Content $PulseTimelineStateFile -Raw | ConvertFrom-Json
    if (-not $state.lastSyncedAt) { return $true }
    $last = [datetime]$state.lastSyncedAt
    return ((Get-Date) - $last).TotalDays -ge $PulseTimelineCadenceDays
  } catch {
    return $true
  }
}

function Save-PulseTimelineState {
  param([string]$SyncedFile)

  [pscustomobject]@{
    lastSyncedAt = (Get-Date).ToString("o")
    file = $SyncedFile
    cadenceDays = $PulseTimelineCadenceDays
  } | ConvertTo-Json | Set-Content -Path $PulseTimelineStateFile -Encoding UTF8
}

Set-Location $RepoRoot

if (-not $SkipPulse) {
  $PulseExtraArgs = @()
  $PulseTimelineUsed = ""
  $PulseTimelineSource = ""
  if (-not $SkipPulseTimeline -and (Test-PulseTimelineDue)) {
    if ($PulseTimelineFile) {
      $PulseTimelineUsed = Resolve-PulseTimelineFile $PulseTimelineFile
      if (-not $PulseTimelineUsed) {
        "Pulse timeline date sync was due, but the requested timeline file was not found: $PulseTimelineFile" | Tee-Object -FilePath $LogFile -Append
      }
    }

    if ($PulseTimelineUsed) {
      $PulseExtraArgs += @("--pulse-timeline-file", $PulseTimelineUsed)
      "Pulse timeline date sync included from $PulseTimelineUsed" | Tee-Object -FilePath $LogFile -Append
      $PulseTimelineSource = $PulseTimelineUsed
    } else {
      $PulseExtraArgs += @("--pulse-timeline-api")
      "Pulse timeline date sync included from Pulse PM Contracts API." | Tee-Object -FilePath $LogFile -Append
      $PulseTimelineSource = "Pulse PM Contracts API"
    }
  } elseif (-not $SkipPulseTimeline) {
    "Pulse timeline date sync skipped; cadence is $PulseTimelineCadenceDays day(s)." | Tee-Object -FilePath $LogFile -Append
  }

  $PulseSucceeded = Run-Step "Pulse sync" {
    $PulseCommand = if ($DryRun) { "dry-run" } else { "sync" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\pulse-sync\run-pulse-sync.ps1" -Command $PulseCommand @PulseExtraArgs
  }

  if ($PulseSucceeded -and $PulseTimelineSource -and -not $DryRun) {
    Save-PulseTimelineState $PulseTimelineSource
  }
}

if (-not $SkipProcore) {
  $ProcoreSucceeded = Run-Step "Procore observation sync" {
    $ProcoreCommand = if ($DryRun) { "env-check" } else { "sync-auto" }
    $PowerShell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
    if ($DryRun) {
      & $PowerShell -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" $ProcoreCommand
    } else {
      & $PowerShell -NoProfile -ExecutionPolicy Bypass -File ".\procore-browser-sync\run-procore-browser-sync.ps1" $ProcoreCommand --complete-missing --login-timeout 120000 --timeout 45000 --page-timeout 30000 --detail-timeout 45000 --detail-attempts 2 --attempts 2
    }
  }
}

"===== Morning sync finished $(Get-Date -Format s). Failures: $Failures =====" | Tee-Object -FilePath $LogFile -Append

if ($Failures -gt 0) {
  exit 1
}
