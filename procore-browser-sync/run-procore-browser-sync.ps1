param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$BundledNodeModules = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
$BundledPnpmNodeModules = Join-Path $BundledNodeModules ".pnpm\node_modules"

if (Test-Path $BundledNode) {
  $Node = $BundledNode
} else {
  $Node = "node"
}

$NodePaths = @()
if ($env:NODE_PATH) { $NodePaths += $env:NODE_PATH }
if (Test-Path $BundledNodeModules) { $NodePaths += $BundledNodeModules }
if (Test-Path $BundledPnpmNodeModules) { $NodePaths += $BundledPnpmNodeModules }
if ($NodePaths.Count -gt 0) { $env:NODE_PATH = ($NodePaths -join ";") }

Push-Location $RepoRoot
try {
  $PreviousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $Node ".\procore-browser-sync\procore_browser_sync.js" @Arguments
  $ExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorActionPreference
  if ($ExitCode -ne 0) { exit $ExitCode }
} finally {
  Pop-Location
}
