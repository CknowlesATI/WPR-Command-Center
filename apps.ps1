param(
  [Parameter(Position = 0)]
  [ValidateSet("login", "status", "pull", "push", "open")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

$nodeDir = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$pnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

if (-not (Test-Path -LiteralPath $nodeDir)) {
  throw "Could not find bundled Node.js at $nodeDir"
}

if (-not (Test-Path -LiteralPath $pnpm)) {
  throw "Could not find bundled pnpm at $pnpm"
}

$env:PATH = "$nodeDir;$env:PATH"

switch ($Command) {
  "login" { & $pnpm exec clasp login }
  "status" { & $pnpm exec clasp status }
  "pull" { & $pnpm exec clasp pull }
  "push" { & $pnpm exec clasp push }
  "open" { & $pnpm exec clasp open-script }
}
