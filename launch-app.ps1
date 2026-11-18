param(
  [int]$Port = 4318,
  [string]$Config = ""
)

# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK,
# so UTF-8 Chinese text without a BOM breaks the parser and the launcher dies
# silently behind the hidden window.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Config) { $Config = Join-Path $root "meeting.config.local.json" }
$launchLog = Join-Path $root "launch.log"

function Write-LaunchLog([string]$message) {
  try {
    Add-Content -LiteralPath $launchLog -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message) -Encoding UTF8
  } catch {}
}
function Show-Failure([string]$message) {
  Write-LaunchLog("FAILED: " + $message)
  Write-Output ("MeetingBot failed to start: " + $message)
  Write-Output ("Details: " + $launchLog)
  # The shortcut may run PowerShell in a hidden/normal window that closes as
  # soon as the script exits. A modal dialog keeps the reason on screen.
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(
      ("MeetingBot failed to start:`n" + $message + "`n`nLog: " + $launchLog),
      "MeetingBot",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } catch {}
  exit 1
}

Write-LaunchLog("launch start; config=" + $Config)

# A terminal/agent host may inject these. ELECTRON_RUN_AS_NODE makes Electron
# run as plain Node (main.cjs then fails on app.on). NODE_OPTIONS pointing at a
# host --require shim crashes Electron's bundled Node during preload, so the
# window dies with exit code 1 and no visible error. Windows PowerShell 5.1
# also throws "An item with the same key has already been added" when both
# HTTP_PROXY and http_proxy exist in the environment.
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:NODE_OPTIONS -ErrorAction SilentlyContinue
foreach ($name in @("http_proxy", "https_proxy")) {
  $upper = $name.ToUpperInvariant()
  $upperValue = [Environment]::GetEnvironmentVariable($upper)
  if ($upperValue -and (Test-Path ("Env:" + $name))) {
    Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
    Write-LaunchLog("removed duplicate env var " + $name)
  }
}

# Prefer the native Electron shell. It starts the panel server itself.
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$main = Join-Path $root "electron\main.cjs"
if ((Test-Path $electron) -and (Test-Path $main)) {
  try {
    $env:MEETINGBOT_CONFIG = $Config
    $p = Start-Process -FilePath $electron -ArgumentList @(
      "--no-sandbox",
      "--config=$Config",
      $main
    ) -WorkingDirectory $root -PassThru
    Write-LaunchLog("electron started pid=" + $p.Id)
    # Start-Process can succeed while the app dies immediately. Give it a
    # moment and only report success if the window process is still alive.
    Start-Sleep -Milliseconds 1200
    $p.Refresh()
    if (-not $p.HasExited) {
      Write-Output "Started MeetingBot Electron PID=$($p.Id)"
      Write-LaunchLog("electron alive, done")
      exit 0
    }
    Write-LaunchLog("electron exited immediately, code=" + $p.ExitCode + "; falling back to Edge")
  } catch {
    Write-LaunchLog("electron Start-Process threw: " + $_.Exception.Message)
  }
} else {
  Write-LaunchLog("electron.exe or main.cjs missing; falling back to Edge")
}

# Fallback: a chromeless Edge window against the local panel server.
try {
  # An old panel server from a previous version may still hold port 4318.
  # Reusing it would open the OLD panel inside this launch, so /health alone
  # is not enough: the served version must match this build's package.json.
  $expectedVersion = ""
  try {
    $expectedVersion = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
  } catch {}

  $stale = $false
  $stalePid = ""
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing | Out-Null
    $alive = $true
    if ($expectedVersion) {
      try {
        $cfg = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/config" -TimeoutSec 3 -UseBasicParsing
        $servedVersion = ([regex]::Match($cfg.Content, '"version"\s*:\s*"([^"]+)"')).Groups[1].Value
        if ($servedVersion -and ($servedVersion -ne $expectedVersion)) { $stale = $true }
      } catch {
        # /api/config not readable: assume compatibility and reuse.
      }
    }
  } catch { $alive = $false }

  if ($stale) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $stalePid = $conn.OwningProcess }
    Show-Failure ("Port $Port is held by an older MeetingBot panel (serving v" + $servedVersion + ", this build is v" + $expectedVersion + "). Close it first" + $(if ($stalePid) { " (process id " + $stalePid + ")" } else { "" }) + ", or start with -Port to pick another port.")
  }

  if (-not $alive) {
    $panelLog = Join-Path $root "panel-server.log"
    $panelErr = Join-Path $root "panel-server.err.log"
    $nodeArgs = @((Join-Path $root "bin\meetingbot.mjs"), "panel", "--config", $Config, "--port", "$Port")
    # PowerShell 5.1 refuses identical stdout/stderr redirect targets.
    Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $panelLog -RedirectStandardError $panelErr | Out-Null
    Write-LaunchLog("started panel server on port " + $Port)
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 200
      try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing | Out-Null
        $ok = $true
        break
      } catch {}
    }
    if (-not $ok) { Show-Failure ("Local panel server did not start. See " + $panelLog) }
  }

  $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
  if (-not (Test-Path $edge)) {
    $cmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($cmd) { $edge = $cmd.Source }
  }
  if (-not (Test-Path $edge)) { Show-Failure "Microsoft Edge not found; cannot open fallback window." }

  $profile = Join-Path $env:LOCALAPPDATA "MeetingBot\edge-profile"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=http://127.0.0.1:$Port",
    "--user-data-dir=$profile",
    "--window-size=1280,820",
    "--no-first-run",
    "--disable-features=msEdgeSidebarV2"
  )
  Write-LaunchLog("opened fallback window at port " + $Port)
  Write-Output "Opened MeetingBot fallback window at http://127.0.0.1:$Port"
  exit 0
} catch {
  Show-Failure ("Fallback window failed: " + $_.Exception.Message)
}
