[CmdletBinding()]
param(
    [string]$Server = "",
    [int]$Port = 0,
    [string]$IdentityFile = "",
    [int]$RemoteControlPort = 16081,
    [int]$RemoteLifecyclePort = 16082,
    [bool]$EnableSocks = $true,
    [int]$SocksPort = 1080,
    [switch]$SkipLocalHealthCheck,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$splitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$settingsPath = Join-Path $splitRoot "settings.json"
$settingsExample = Join-Path $splitRoot "settings.example.json"
$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"

if (-not (Test-Path -LiteralPath $settingsPath)) {
    Copy-Item -LiteralPath $settingsExample -Destination $settingsPath
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
if (-not $Server) { $Server = [string]$settings.server }
if ($Port -le 0) { $Port = if ($settings.sshPort) { [int]$settings.sshPort } else { 22 } }
if (-not $IdentityFile) {
    $IdentityFile = if ($settings.identityFile) {
        [Environment]::ExpandEnvironmentVariables([string]$settings.identityFile)
    } else {
        "$env:USERPROFILE\.ssh\id_ed25519"
    }
}

if (-not (Test-Path -LiteralPath $ssh)) {
    throw "Windows OpenSSH was not found at $ssh"
}
if (-not $Server) {
    throw "Set server in settings.json (for example, your-user@your-server)."
}
if (-not (Test-Path -LiteralPath $IdentityFile)) {
    throw "SSH identity file was not found: $IdentityFile"
}

if (-not $DryRun -and -not $SkipLocalHealthCheck) {
    foreach ($endpoint in @(
        "http://127.0.0.1:6081/health",
        "http://127.0.0.1:6084/health"
    )) {
        try {
            $health = Invoke-RestMethod -Uri $endpoint -TimeoutSec 3
            if (-not $health.ok) { throw "not ready" }
        } catch {
            throw "The local split browser is not ready at $endpoint. Run start.ps1 first."
        }
    }
}

$arguments = @(
    "-i", $IdentityFile,
    "-p", [string]$Port,
    "-N",
    "-R", "127.0.0.1:${RemoteControlPort}:127.0.0.1:6081",
    "-R", "127.0.0.1:${RemoteLifecyclePort}:127.0.0.1:6084",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new"
)
if ($EnableSocks) {
    $arguments += @("-D", "127.0.0.1:${SocksPort}")
}
$arguments += $Server

if ($DryRun) {
    Write-Output ($arguments -join " ")
    return
}

Write-Output "Handing the local browser to the SameWindow agent at $Server."
Write-Output "Remote loopback: control $RemoteControlPort, lifecycle $RemoteLifecyclePort."
if ($EnableSocks) {
    Write-Output "SOCKS privacy exit is listening locally on $SocksPort."
}
Write-Output "Silence means the tunnel is healthy. Press Ctrl+C to stop."

while ($true) {
    & $ssh @arguments
    $exitCode = $LASTEXITCODE
    Write-Warning "Split-browser tunnel exited with code $exitCode. Retrying in 5 seconds."
    Start-Sleep -Seconds 5
}
