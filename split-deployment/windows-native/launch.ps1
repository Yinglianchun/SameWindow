[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$splitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $splitRoot "runtime"
$tunnelPidPath = Join-Path $runtimeRoot "tunnel.pid"
$settingsPath = Join-Path $splitRoot "settings.json"
$settingsExample = Join-Path $splitRoot "settings.example.json"
$powershell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $powershell)) {
    $powershell = (Get-Command powershell.exe).Source
}

if (-not (Test-Path -LiteralPath $settingsPath)) {
    Copy-Item -LiteralPath $settingsExample -Destination $settingsPath
    throw "Created settings.json. Set its server field, then run launch.ps1 again."
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
if (-not [string]$settings.server) {
    throw "Set server in settings.json (for example, your-user@your-server)."
}

$tunnelAlive = $false
if (Test-Path -LiteralPath $tunnelPidPath) {
    $savedPid = [int](Get-Content -LiteralPath $tunnelPidPath -Raw)
    $savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    $tunnelAlive = $savedProcess -and $savedProcess.CommandLine -like "*windows-native*tunnel.ps1*"
}

if (-not $tunnelAlive) {
    $tunnelProcess = Start-Process -FilePath $powershell `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $splitRoot "tunnel.ps1"),
            "-SkipLocalHealthCheck"
        ) `
        -WorkingDirectory $splitRoot `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $tunnelPidPath -Value $tunnelProcess.Id -Encoding ascii
}

& (Join-Path $splitRoot "start.ps1")

Write-Output "SameWindow is open. The VPS tunnel is running quietly in the background."
