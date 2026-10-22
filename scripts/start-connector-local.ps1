# Starts the installed Tally Bridge Connector against THIS local backend
# instead of the BACKEND_URL baked into its bundled .env.
#
# The connector loads its .env with plain dotenv.config(), which never
# overrides variables already in the environment — so setting them here,
# for this process only, redirects it without rebuilding the app or
# touching system-wide environment variables.
#
# The connector's /pair route also queries Postgres directly (to look up the
# pairing token's user), so DB_* must point at the same database this
# backend uses. They are read from this backend's .env, not duplicated here.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-connector-local.ps1
#         (optional) -BackendUrl http://100.91.212.45:5001

param(
  [string]$BackendUrl = "http://100.91.212.45:5001"
)

$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "..\.env"
$exe = Join-Path $env:LOCALAPPDATA "Programs\tally-automation-connector-be\Tally Bridge Connector.exe"

if (-not (Test-Path $envFile)) { throw "Backend .env not found at $envFile" }
if (-not (Test-Path $exe)) { throw "Connector not installed at $exe" }

$beEnv = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
    $beEnv[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
  }
}

foreach ($name in "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME") {
  if (-not $beEnv[$name]) { throw "$name missing from backend .env" }
  [Environment]::SetEnvironmentVariable($name, $beEnv[$name], "Process")
}
[Environment]::SetEnvironmentVariable("BACKEND_URL", $BackendUrl, "Process")

# One instance only — the old one holds port 5002 and keeps polling the
# remote backend.
$running = Get-Process -Name "Tally Bridge Connector" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Stopping running connector..."
  try {
    $running | Stop-Process -Force -ErrorAction Stop
  } catch {
    # An instance started "as administrator" can't be stopped from a
    # normal shell. The app itself doesn't need admin (asInvoker).
    Write-Host "Could not stop it: $($_.Exception.Message)"
    Write-Host "Quit Tally Bridge Connector yourself (tray icon -> Quit, or Task Manager), then run this again."
    exit 1
  }
  Start-Sleep -Seconds 2
}

Start-Process -FilePath $exe
Write-Host "Connector started -> $BackendUrl (DB $($beEnv['DB_NAME']) on $($beEnv['DB_HOST']):$($beEnv['DB_PORT']))"
