param(
  [ValidateSet("login-test", "dry-run", "sync", "search-projects")]
  [string]$Command = "dry-run",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $ScriptDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$LogFile = Join-Path $LogDir "pulse-sync-$Stamp-$PID.log"

Set-Location $RepoRoot

$NodePath = $env:PULSE_SYNC_NODE
if (-not $NodePath) {
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($NodeCommand) {
    $NodePath = $NodeCommand.Source
  }
}

if (-not $NodePath) {
  $BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $BundledNode) {
    $NodePath = $BundledNode
  }
}

if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw "Node.js was not found. Install Node.js or set PULSE_SYNC_NODE to node.exe."
}

& $NodePath ".\pulse-sync\pulse-sync.js" $Command @RemainingArgs *>&1 | Tee-Object -FilePath $LogFile
