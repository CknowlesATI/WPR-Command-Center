param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$HostedRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $HostedRoot
$Python = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (-not (Test-Path -LiteralPath $Python)) {
  throw "Could not find bundled Python at $Python"
}

$Existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($Existing) {
  Write-Output "Preview already running at http://127.0.0.1:$Port/"
  exit 0
}

$LogDir = Join-Path $RepoRoot "tmp"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog = Join-Path $LogDir "hosted-command-center-preview.out.log"
$ErrLog = Join-Path $LogDir "hosted-command-center-preview.err.log"

Start-Process `
  -FilePath $Python `
  -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1") `
  -WorkingDirectory $HostedRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog | Out-Null

Start-Sleep -Seconds 2
Write-Output "Preview running at http://127.0.0.1:$Port/"
