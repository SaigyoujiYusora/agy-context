#requires -Version 7.0
<#
.SYNOPSIS
    Installs or uninstalls AGY Context in ~/.gemini/config/plugins/agy-model-inspector
    so Antigravity automatically discovers it in the plugin list, and manages the local backend.
#>
[CmdletBinding()]
param(
    [switch]$NoStart,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$targetDir = Join-Path $HOME '.gemini\config\plugins\agy-model-inspector'
$dataDir = Join-Path $HOME '.gemini\antigravity\plugin_data\agy-model-inspector'

function Stop-InspectorProcesses {
    $endpointFile = Join-Path $dataDir 'ls_endpoint.json'
    $badgePort = 18922
    $sidecarPort = $badgePort
    $lsAddr = ''
    $csrfToken = ''
    if (Test-Path -LiteralPath $endpointFile) {
        try {
            $ep = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
            if ($ep.sidecarPort) { $sidecarPort = [int]$ep.sidecarPort }
            if ($ep.lsAddress) { $lsAddr = [string]$ep.lsAddress }
            if ($ep.csrfToken) { $csrfToken = [string]$ep.csrfToken }
        } catch {}
    }

    # Stop runtime-injector before restarting server.mjs to avoid a race where
    # Antigravity auto-restarts sidecar -> spawns injector -> old cleanup kills it.
    $injectorPids = @()
    try {
        $injectorPids += (Get-NetTCPConnection -LocalPort 18923 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
    } catch {}
    try {
        $injectorPids += (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*agy-model-inspector*runtime-injector.mjs*' } |
            Select-Object -ExpandProperty ProcessId)
    } catch {}
    foreach ($ipid in ($injectorPids | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
        try {
            Stop-Process -Id $ipid -Force -ErrorAction SilentlyContinue
        } catch {}
    }

    try { Invoke-RestMethod -Uri "http://127.0.0.1:$badgePort/api/shutdown" -TimeoutSec 1 | Out-Null } catch {}
    if ($sidecarPort -ne $badgePort) {
        try { Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/api/shutdown" -TimeoutSec 1 | Out-Null } catch {}
    }

    return @{
        BadgePort = $badgePort
        LsAddress = $lsAddr
        CsrfToken = $csrfToken
    }
}

if ($Uninstall) {
    Stop-InspectorProcesses | Out-Null
    if (Test-Path -LiteralPath $targetDir) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
        Write-Host "Uninstalled plugin from: $targetDir" -ForegroundColor Yellow
    } else {
        Write-Host "Plugin directory not found: $targetDir" -ForegroundColor DarkGray
    }
    return
}

$items = @(
    'plugin.json',
    'hooks.json',
    'README.md',
    'assets',
    'rules',
    'scripts',
    'sidecars',
    'skills'
)

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
foreach ($item in $items) {
    $srcPath = Join-Path $sourceDir $item
    if (-not (Test-Path -LiteralPath $srcPath)) {
        throw "Missing required plugin item: $item"
    }
    $dstPath = Join-Path $targetDir $item
    if (Test-Path -LiteralPath $srcPath -PathType Container) {
        New-Item -ItemType Directory -Path $dstPath -Force | Out-Null
        Copy-Item -Path "$srcPath\*" -Destination $dstPath -Recurse -Force
    } else {
        Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
    }
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$configPath = Join-Path $dataDir 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    @{
        badgeMode          = 'off'
        tpsMode            = 'decode'
        showTokenDetails   = $true
        showTTFT           = $true
        showInternalEnum   = $true
        nativePromptPython = ''
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
}

Write-Host "Installed plugin to: $targetDir" -ForegroundColor Green
Write-Host "Antigravity automatically discovers plugins in ~/.gemini/config/plugins/ (restart or refresh Plugins Manager if already running)." -ForegroundColor DarkGray

if ($NoStart) {
    return
}

$procInfo = Stop-InspectorProcesses
Start-Sleep -Milliseconds 300

$node = (Get-Command node -ErrorAction Stop).Source
$serverScript = Join-Path $targetDir 'sidecars\panel\server.mjs'
$injectorScript = Join-Path $targetDir 'scripts\runtime-injector.mjs'

if (Test-Path -LiteralPath $serverScript) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($node, "--no-warnings `"$serverScript`"")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.Environment['ANTIGRAVITY_SIDECAR_WEB_PORT'] = [string]$procInfo.BadgePort
    if ($procInfo.LsAddress) { $psi.Environment['ANTIGRAVITY_LS_ADDRESS'] = $procInfo.LsAddress }
    if ($procInfo.CsrfToken) { $psi.Environment['ANTIGRAVITY_CSRF_TOKEN'] = $procInfo.CsrfToken }
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-Host "Started backend server on http://127.0.0.1:$($procInfo.BadgePort)." -ForegroundColor Cyan
}

# Ensure runtime-injector (18923) is running even if Antigravity's auto-restarted sidecar already claimed 18922.
Start-Sleep -Milliseconds 600
$injectorUp = $false
try {
    $injectorUp = [bool](Get-NetTCPConnection -LocalPort 18923 -ErrorAction SilentlyContinue)
} catch {}
if (-not $injectorUp -and (Test-Path -LiteralPath $injectorScript)) {
    $ipsi = [System.Diagnostics.ProcessStartInfo]::new($node, "--no-warnings `"$injectorScript`"")
    $ipsi.UseShellExecute = $false
    $ipsi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($ipsi) | Out-Null
    Write-Host "Started CDP runtime injector (port 18923)." -ForegroundColor Cyan
}
