#requires -Version 7.0
<#
.SYNOPSIS
    Installs or uninstalls AGY Context in ~/.gemini/config/plugins/agy-model-inspector
    and configures the DWrite.dll + resources/app direct loader (no CDP required,
    app.asar and version.dll stay completely untouched).
#>
[CmdletBinding()]
param(
    [string]$AntigravityDir = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity'),
    [switch]$NoDllLoader,
    [switch]$NoStart,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$targetDir = Join-Path $HOME '.gemini\config\plugins\agy-model-inspector'
$dataDir = Join-Path $HOME '.gemini\antigravity\plugin_data\agy-model-inspector'
$loaderMarker = 'AGY_CONTEXT_ELECTRON_LOADER'
$dllMarkerBytes = [System.Text.Encoding]::ASCII.GetBytes('AGY_CONTEXT_DWRITE_LOADER_V1')

function Test-IsOurDwriteDll {
    param([string]$DllPath)
    if (-not (Test-Path -LiteralPath $DllPath)) { return $false }
    $bytes = [System.IO.File]::ReadAllBytes($DllPath)
    $mLen = $dllMarkerBytes.Length
    if ($bytes.Length -lt $mLen) { return $false }
    for ($i = 0; $i -le ($bytes.Length - $mLen); $i++) {
        $match = $true
        for ($j = 0; $j -lt $mLen; $j++) {
            if ($bytes[$i + $j] -ne $dllMarkerBytes[$j]) { $match = $false; break }
        }
        if ($match) { return $true }
    }
    return $false
}

function Read-AsarPackageMeta {
    param([string]$AsarPath)
    $js = @'
const fs = require('fs');
const asarPath = process.env.AGY_ASAR_PATH;
const buf = fs.readFileSync(asarPath);
if (buf.length < 16) throw new Error('Invalid ASAR');
const headerPayloadSize = buf.readUInt32LE(4);
const strLen = buf.readUInt32LE(12);
const dataOffset = 8 + headerPayloadSize;
const tree = JSON.parse(buf.subarray(16, 16 + strLen).toString('utf8'));
const node = tree && tree.files && tree.files['package.json'];
if (!node || node.files || node.unpacked) throw new Error('package.json not found in app.asar');
const start = dataOffset + Number(node.offset);
const pkg = JSON.parse(buf.subarray(start, start + node.size).toString('utf8'));
console.log(JSON.stringify({
  name: pkg.name || 'antigravity',
  productName: pkg.productName || 'Antigravity',
  version: pkg.version || '0.0.0',
  main: pkg.main || 'dist/main.js'
}));
'@
    $prev = $env:AGY_ASAR_PATH
    try {
        $env:AGY_ASAR_PATH = $AsarPath
        $out = $js | & node -
    } finally {
        if ($null -eq $prev) { Remove-Item Env:AGY_ASAR_PATH -ErrorAction SilentlyContinue } else { $env:AGY_ASAR_PATH = $prev }
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to read package.json from $AsarPath" }
    return ($out | ConvertFrom-Json)
}

function Install-DirectDllLoader {
    param([string]$AppRoot, [string]$PluginDir)
    $exePath = Join-Path $AppRoot 'Antigravity.exe'
    $asarPath = Join-Path $AppRoot 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $asarPath)) {
        Write-Warning "Antigravity installation not found at $AppRoot; skipped DWrite.dll direct loader."
        return $false
    }

    # 1. Write resources/app bootstrap entry (triggered by DWrite.dll one-shot redirect; app.asar untouched)
    $meta = Read-AsarPackageMeta -AsarPath $asarPath
    $appDir = Join-Path $AppRoot 'resources\app'
    $pkgPath = Join-Path $appDir 'package.json'
    $indexPath = Join-Path $appDir 'index.cjs'
    $loaderScript = (Join-Path $PluginDir 'scripts\electron-overlay-loader.cjs') -replace '\\', '/'
    $escapedLoader = $loaderScript.Replace("'", "\'")
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    $pkgObj = [ordered]@{
        name        = $meta.name
        productName = $meta.productName
        version     = $meta.version
        main        = 'index.cjs'
    }
    [System.IO.File]::WriteAllText($pkgPath, (($pkgObj | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

    $indexCode = @"
'use strict';
// $loaderMarker - side-by-side bootstrapper (app.asar left untouched)

const fs = require('fs');
const path = require('path');

const LOADER_PATH = '$escapedLoader';
try {
  if (fs.existsSync(LOADER_PATH)) {
    require(LOADER_PATH);
  }
} catch (err) {
  console.warn('[AGY Context] Direct Electron loader skipped:', err && err.message ? err.message : err);
}

const asarPath = path.resolve(__dirname, '..', 'app.asar');
let realPkg = { version: '$($meta.version)', main: '$($meta.main)' };
try {
  realPkg = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
} catch {}

try {
  const electron = require('electron');
  if (electron && electron.app) {
    if (realPkg && realPkg.version) {
      electron.app.getVersion = () => realPkg.version;
    }
    electron.app.getAppPath = () => asarPath;
  }
} catch {}

const mainRel = (realPkg && realPkg.main) ? realPkg.main : 'dist/main.js';
module.exports = require(path.join(asarPath, mainRel));
"@
    [System.IO.File]::WriteAllText($indexPath, $indexCode, $utf8NoBom)

    # 2. Deploy native/DWrite.dll (rename old locked copy if Antigravity is currently running)
    $srcDll = Join-Path $sourceDir 'native\DWrite.dll'
    if (-not (Test-Path -LiteralPath $srcDll)) {
        $buildScript = Join-Path $sourceDir 'native\build-dll.ps1'
        if (Test-Path -LiteralPath $buildScript) { & $buildScript }
    }
    if (-not (Test-Path -LiteralPath $srcDll)) {
        throw "DWrite.dll not found at $srcDll (run native/build-dll.ps1 to build it)."
    }

    $dstDll = Join-Path $AppRoot 'DWrite.dll'
    # Also keep a copy inside the installed plugin directory so DWrite.dll can self-update on future releases.
    $pluginNativeDir = Join-Path $PluginDir 'native'
    New-Item -ItemType Directory -Path $pluginNativeDir -Force | Out-Null
    Copy-Item -LiteralPath $srcDll -Destination (Join-Path $pluginNativeDir 'DWrite.dll') -Force
    $oldDll = Join-Path $AppRoot 'DWrite.dll.old'
    if (Test-Path -LiteralPath $oldDll) {
        Remove-Item -LiteralPath $oldDll -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $dstDll) -and -not (Test-IsOurDwriteDll -DllPath $dstDll)) {
        throw "Refusing to overwrite non-AGY-Context DWrite.dll at: $dstDll"
    }
    try {
        Copy-Item -LiteralPath $srcDll -Destination $dstDll -Force
    } catch {
        # Windows allows renaming a loaded DLL so the new copy takes effect on next launch.
        if (Test-Path -LiteralPath $oldDll) {
            $oldDll = Join-Path $AppRoot ('DWrite.dll.old.' + (Get-Date -Format 'HHmmss'))
        }
        Move-Item -LiteralPath $dstDll -Destination $oldDll -Force
        Copy-Item -LiteralPath $srcDll -Destination $dstDll -Force
    }

    Write-Host "Installed DWrite.dll + resources/app direct loader (no CDP needed, app.asar & version.dll untouched)." -ForegroundColor Green
    return $true
}

function Remove-DirectDllLoader {
    param([string]$AppRoot)
    $appDir = Join-Path $AppRoot 'resources\app'
    $indexPath = Join-Path $appDir 'index.cjs'
    if (Test-Path -LiteralPath $indexPath) {
        $content = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($content -and $content.Contains($loaderMarker)) {
            Remove-Item -LiteralPath $appDir -Recurse -Force
            Write-Host "Removed resources/app loader directory: $appDir" -ForegroundColor Yellow
        }
    }
    Get-ChildItem -LiteralPath $AppRoot -Filter 'DWrite.dll.old*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
    $dstDll = Join-Path $AppRoot 'DWrite.dll'
    if (Test-Path -LiteralPath $dstDll) {
        if (-not (Test-IsOurDwriteDll -DllPath $dstDll)) {
            Write-Warning "Skipped removing $dstDll (not created by AGY Context)."
            return
        }
        try {
            Remove-Item -LiteralPath $dstDll -Force
            Write-Host "Removed DWrite.dll direct loader: $dstDll" -ForegroundColor Yellow
        } catch {
            Write-Warning "Could not remove $dstDll while Antigravity is running; quit Antigravity (tray -> Quit) and delete it or re-run -Uninstall."
        }
    }
}

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

    $injectorPids = @()
    try {
        $injectorPids += (Get-NetTCPConnection -LocalPort 18923 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
    } catch {}
    try {
        $injectorPids += (Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'Antigravity.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*agy-model-inspector*runtime-injector.mjs*' } |
            Select-Object -ExpandProperty ProcessId)
    } catch {}
    foreach ($ipid in ($injectorPids | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
        try { Stop-Process -Id $ipid -Force -ErrorAction SilentlyContinue } catch {}
    }

    $hadManagedSidecar = $false
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$badgePort/api/shutdown" -TimeoutSec 1 | Out-Null } catch {}
    if ($sidecarPort -ne $badgePort) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/api/shutdown" -TimeoutSec 1 | Out-Null
            $hadManagedSidecar = $true
        } catch {}
    }

    return @{
        BadgePort         = $badgePort
        LsAddress         = $lsAddr
        CsrfToken         = $csrfToken
        HadManagedSidecar = $hadManagedSidecar
    }
}

if ($Uninstall) {
    Stop-InspectorProcesses | Out-Null
    Remove-DirectDllLoader -AppRoot $AntigravityDir
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
    'scripts',
    'sidecars'
)

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
foreach ($legacyDir in @('rules', 'skills')) {
    $legacyPath = Join-Path $targetDir $legacyDir
    if (Test-Path -LiteralPath $legacyPath) {
        Remove-Item -LiteralPath $legacyPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}
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
        badgeMode             = 'off'
        tpsMode               = 'decode'
        showTokenDetails      = $true
        showTTFT              = $true
        showInternalEnum      = $true
        nativePromptPython    = ''
        disableAutoDllInstall = [bool]$NoDllLoader
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
} else {
    try {
        $existingCfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($existingCfg -is [hashtable]) {
            $existingCfg['disableAutoDllInstall'] = [bool]$NoDllLoader
            $existingCfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
        }
    } catch {}
}

Write-Host "Installed plugin to: $targetDir" -ForegroundColor Green

$dllInstalled = $false
if (-not $NoDllLoader) {
    $dllInstalled = Install-DirectDllLoader -AppRoot $AntigravityDir -PluginDir $targetDir
}

if ($dllInstalled) {
    Write-Host "Completely quit and reopen Antigravity once (tray -> Quit) to activate DWrite.dll direct overlay injection." -ForegroundColor Yellow
} else {
    Write-Host "Antigravity automatically discovers plugins in ~/.gemini/config/plugins/ (restart or refresh Plugins Manager if already running)." -ForegroundColor DarkGray
}

if ($NoStart) {
    return
}

$procInfo = Stop-InspectorProcesses
Start-Sleep -Milliseconds 400

if ($procInfo.HadManagedSidecar) {
    Write-Host "Signaled Antigravity-managed sidecar to reload (restart_policy: always)." -ForegroundColor Cyan
    return
}

$node = (Get-Command node -ErrorAction Stop).Source
$serverScript = Join-Path $targetDir 'sidecars\panel\server.mjs'
if (Test-Path -LiteralPath $serverScript) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($node, "--no-warnings `"$serverScript`"")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.Environment['ANTIGRAVITY_SIDECAR_WEB_PORT'] = [string]$procInfo.BadgePort
    if ($dllInstalled) { $psi.Environment['AGY_DISABLE_RUNTIME_INJECTOR'] = '1' }
    if ($procInfo.LsAddress) { $psi.Environment['ANTIGRAVITY_LS_ADDRESS'] = $procInfo.LsAddress }
    if ($procInfo.CsrfToken) { $psi.Environment['ANTIGRAVITY_CSRF_TOKEN'] = $procInfo.CsrfToken }
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-Host "Started backend server on http://127.0.0.1:$($procInfo.BadgePort)." -ForegroundColor Cyan
}
