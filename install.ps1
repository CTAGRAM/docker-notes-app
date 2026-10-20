# Docker Notes - one-command installer for Windows (PowerShell 5.1 or later).
#
#   irm https://raw.githubusercontent.com/CTAGRAM/docker-notes-app/main/install.ps1 | iex
#
# Installs Git and Docker Desktop if they are missing (using winget), starts Docker if it
# isn't running, downloads (or updates) the app and starts it. Safe to run again at any time.
#
# Optional settings, set before running:
#   $env:NOTES_DIR = 'C:\some\folder'    # where to put the app (default: ~\docker-notes-app)
#   $env:HOST_PORT = '8080'              # port to use (default: 3000, or the next free port)

& {
  $Repo    = 'CTAGRAM/docker-notes-app'
  $RepoUrl = "https://github.com/$Repo.git"
  $ZipUrl  = "https://github.com/$Repo/archive/refs/heads/main.zip"
  $Dir     = if ($env:NOTES_DIR) { $env:NOTES_DIR } else { Join-Path $HOME 'docker-notes-app' }
  $DockerDesktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  $DockerBin        = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'

  function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
  function Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
  function Has($cmd)  { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

  function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-Path $DockerBin) { $env:Path = "$DockerBin;$env:Path" }
  }

  # Runs a native command silently; returns $true when it exits with code 0.
  function Test-Command([scriptblock]$Command) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try { & $Command *> $null; return ($LASTEXITCODE -eq 0) }
    catch { return $false }
    finally { $ErrorActionPreference = $old }
  }

  function Test-DockerReady { (Has docker) -and (Test-Command { docker info }) }

  function Wait-Until([int]$Seconds, [scriptblock]$Condition) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (& $Condition)) {
      if ((Get-Date) -gt $deadline) { Write-Host ''; return $false }
      Write-Host '.' -NoNewline
      Start-Sleep -Seconds 3
    }
    Write-Host ''
    return $true
  }

  function Test-PortBusy([int]$Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  }

  Push-Location
  try {
    Say 'Installing Docker Notes'
    Update-SessionPath
    $hasWinget = Has winget

    # 1. Git
    if (-not (Has git)) {
      if ($hasWinget) {
        Say 'Git is not installed - installing it...'
        winget install --id Git.Git -e --source winget
        Update-SessionPath
      }
      if (-not (Has git)) { Warn 'Git is not available - downloading the app without it.' }
    }

    # 2. Docker Desktop
    if (-not (Test-Path $DockerDesktopExe) -and -not (Has docker)) {
      if (-not $hasWinget) {
        throw 'Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ and run this command again.'
      }
      Say 'Docker Desktop is not installed - installing it (approve the admin prompt; this takes a few minutes)...'
      winget install --id Docker.DockerDesktop -e --source winget
      Update-SessionPath
      if (-not (Test-Path $DockerDesktopExe) -and -not (Has docker)) {
        throw 'Docker Desktop did not finish installing. Restart your computer if Windows asks you to, then run this command again.'
      }
    }

    # 3. Make sure Docker is running
    if (-not (Test-DockerReady)) {
      if (Test-Path $DockerDesktopExe) {
        Say 'Docker is not running - opening Docker Desktop...'
        Start-Process -FilePath $DockerDesktopExe
      }
      Write-Host 'Waiting for Docker to start (the first start can take a few minutes; finish any Docker Desktop setup screens)' -NoNewline
      if (-not (Wait-Until 300 { Test-DockerReady })) {
        throw "Docker did not start. Open Docker Desktop, wait until it says 'Engine running' (restart your PC if it asks), then run this command again."
      }
    }

    # 4. Download or update the app
    if ((Has git) -and (Test-Path (Join-Path $Dir '.git'))) {
      Say "Updating the app in $Dir ..."
      git -C $Dir pull --ff-only --quiet
      if ($LASTEXITCODE -ne 0) { Warn 'Could not update (local changes?) - using the existing copy.' }
    }
    elseif ((Has git) -and -not (Test-Path $Dir)) {
      Say "Downloading the app to $Dir ..."
      git clone --quiet $RepoUrl $Dir
      if ($LASTEXITCODE -ne 0) { throw 'Downloading the app with git failed.' }
    }
    else {
      Say "Downloading the app to $Dir ..."
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $tmp = Join-Path ([IO.Path]::GetTempPath()) ('docker-notes-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $tmp | Out-Null
      Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile (Join-Path $tmp 'app.zip')
      Expand-Archive -Path (Join-Path $tmp 'app.zip') -DestinationPath $tmp -Force
      New-Item -ItemType Directory -Path $Dir -Force | Out-Null
      Copy-Item -Path (Join-Path $tmp 'docker-notes-app-main\*') -Destination $Dir -Recurse -Force
      Remove-Item -LiteralPath $tmp -Recurse -Force
    }

    Set-Location -LiteralPath $Dir

    # 5. Pick a free port (remembered in .env) and start the app
    Test-Command { docker compose down --remove-orphans } | Out-Null

    $envFile = Join-Path $Dir '.env'
    $saved = if (Test-Path $envFile) { Get-Content $envFile | Where-Object { $_ -match '^HOST_PORT=\d+' } | Select-Object -Last 1 } else { $null }
    $port = if ($env:HOST_PORT) { [int]$env:HOST_PORT } elseif ($saved) { [int]($saved -replace '^HOST_PORT=(\d+).*$', '$1') } else { 3000 }
    $start = $port
    while (Test-PortBusy $port) {
      $port++
      if ($port -gt $start + 50) { throw "No free port found near $start. Set `$env:HOST_PORT to a free port and run again." }
    }
    if ($port -ne $start) { Warn "Port $start is already in use - using port $port instead." }
    $other = if (Test-Path $envFile) { @(Get-Content $envFile | Where-Object { $_ -notmatch '^HOST_PORT=' }) } else { @() }
    Set-Content -Path $envFile -Value ($other + "HOST_PORT=$port") -Encoding Ascii

    Say 'Building and starting Docker Notes (the first run takes a minute)...'
    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Starting the app failed - see the messages above.' }

    $url = "http://localhost:$port"
    Write-Host 'Waiting for the app to be ready' -NoNewline
    $ready = Wait-Until 120 {
      try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "$url/health").StatusCode -eq 200 } catch { $false }
    }
    if (-not $ready) { throw "The app did not start. See the logs with:  cd `"$Dir`"; docker compose logs" }

    Start-Process $url
    Write-Host ''
    Write-Host "Docker Notes is running at $url" -ForegroundColor Green
    Write-Host ''
    Write-Host "  App folder:  $Dir"
    Write-Host "  Stop it:     cd `"$Dir`"; docker compose down"
    Write-Host '  Start again: run this installer again (it also updates the app)'
    Write-Host ''
  }
  catch {
    Write-Host "xx  $($_.Exception.Message)" -ForegroundColor Red
  }
  finally {
    Pop-Location
  }
}
