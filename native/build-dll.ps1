#requires -Version 7.0
<#
.SYNOPSIS
    Builds native/DWrite.dll (x64) from native/dwrite_loader.c using MSVC Build Tools.
#>
$ErrorActionPreference = 'Stop'

$nativeDir = $PSScriptRoot
$srcFile = Join-Path $nativeDir 'dwrite_loader.c'
$outDll = Join-Path $nativeDir 'DWrite.dll'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "vswhere.exe not found; install Visual Studio / Build Tools with C++ x64 toolchain."
}
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($vsPath)) {
    throw "MSVC x64 C++ Build Tools not found."
}
$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) {
    throw "vcvars64.bat not found at: $vcvars"
}

$objDir = Join-Path $env:TEMP ('agy-context-dll-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $objDir -Force | Out-Null
try {
    $cmd = "`"$vcvars`" >nul && cl.exe /nologo /O2 /MT /W4 /WX /LD `"$srcFile`" /Fo`"$objDir\\`" /Fe:`"$outDll`" /link /IMPLIB:`"$objDir\DWrite.lib`" kernel32.lib"
    cmd.exe /c $cmd
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outDll)) {
        throw "Build failed with exit code $LASTEXITCODE"
    }
    Write-Host "Built $outDll ($((Get-Item -LiteralPath $outDll).Length) bytes)" -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $objDir -Recurse -Force -ErrorAction SilentlyContinue
}
