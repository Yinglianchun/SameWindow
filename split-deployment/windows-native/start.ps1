[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$splitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $splitRoot)
$runtimeRoot = Join-Path $splitRoot "runtime"
$lifecycleScript = Join-Path $splitRoot "native-lifecycle.mjs"
$settingsPath = Join-Path $splitRoot "settings.json"
$settingsExample = Join-Path $splitRoot "settings.example.json"
$browserPackage = $repoRoot
$pidPath = Join-Path $runtimeRoot "lifecycle.pid"
$stdoutPath = Join-Path $runtimeRoot "lifecycle.log"
$stderrPath = Join-Path $runtimeRoot "lifecycle-error.log"

function Find-Node {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $fallback = "C:\nvm4w\nodejs\node.exe"
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    throw "Node.js was not found."
}

$node = Find-Node
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Copy-Item -LiteralPath $settingsExample -Destination $settingsPath
}

$playwrightPackage = Join-Path $browserPackage "node_modules\playwright-core\package.json"
if (-not (Test-Path -LiteralPath $playwrightPackage)) {
    $npm = Join-Path (Split-Path -Parent $node) "npm.cmd"
    if (-not (Test-Path -LiteralPath $npm)) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npmCommand) { $npm = $npmCommand.Source }
    }
    if (-not (Test-Path -LiteralPath $npm)) {
        throw "npm was not found; it is needed once to install playwright-core."
    }
    & $npm ci --prefix $browserPackage --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "Could not install the local control dependency." }
}

$lifecycleReady = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:6084/health" -TimeoutSec 2
    $lifecycleReady = $health.ok -eq $true
} catch {
}

if (-not $lifecycleReady) {
    $process = Start-Process -FilePath $node `
        -ArgumentList @($lifecycleScript) `
        -WorkingDirectory $splitRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:6084/health" -TimeoutSec 2
            if ($health.ok) {
                $lifecycleReady = $true
                break
            }
        } catch {
        }
        Start-Sleep -Milliseconds 300
    }
}

if (-not $lifecycleReady) {
    if (Test-Path -LiteralPath $stderrPath) { Get-Content $stderrPath -Tail 50 }
    throw "The native lifecycle service did not start."
}

$status = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:6084/api/start" `
    -Headers @{ "X-SameWindow-Lifecycle" = "1" } `
    -TimeoutSec 35

if ($status.state -ne "running") {
    throw "The dedicated Chrome window started in state '$($status.state)'."
}

Write-Output "SameWindow Chrome is ready."
Write-Output "Control:   http://127.0.0.1:6081"
Write-Output "Lifecycle: http://127.0.0.1:6084"
Write-Output "Run tunnel.ps1 in another terminal when you want the remote agent to join."
