[CmdletBinding()]
param(
    [switch]$All
)

$ErrorActionPreference = "Stop"
$splitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $splitRoot "runtime\lifecycle.pid"
$tunnelPidPath = Join-Path $splitRoot "runtime\tunnel.pid"

try {
    $status = Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:6084/api/stop" `
        -Headers @{ "X-SameWindow-Lifecycle" = "1" } `
        -TimeoutSec 15
    Write-Output "SameWindow Chrome stopped. Its login profile was preserved."
} catch {
    Write-Warning "The lifecycle service was not reachable; the browser may already be stopped."
}

if ($All -and (Test-Path -LiteralPath $pidPath)) {
    $lifecyclePid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $lifecyclePid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like "*native-lifecycle.mjs*") {
        Stop-Process -Id $lifecyclePid
    }
    Remove-Item -LiteralPath $pidPath -Force
    Write-Output "The local lifecycle service also stopped."
}

if ($All -and (Test-Path -LiteralPath $tunnelPidPath)) {
    $tunnelPid = [int](Get-Content -LiteralPath $tunnelPidPath -Raw)
    $tunnelProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelPid" -ErrorAction SilentlyContinue
    if ($tunnelProcess -and $tunnelProcess.CommandLine -like "*windows-native*tunnel.ps1*") {
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $tunnelPid" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "ssh.exe" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        Stop-Process -Id $tunnelPid -Force
    }
    Remove-Item -LiteralPath $tunnelPidPath -Force
    Write-Output "The VPS tunnel also stopped."
}
