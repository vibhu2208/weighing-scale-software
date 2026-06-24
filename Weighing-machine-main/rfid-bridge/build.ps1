# Build rfid-bridge.exe for Weighbridge Manager
# Requires: .NET Framework 4.8 + MSBuild (Visual Studio Build Tools)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LibDir = Join-Path $Root "lib"
$LocalDll = Join-Path $LibDir "ReaderAPI.dll"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $Root)
$SdkDllCandidates = @(
    (Join-Path $RepoRoot "SDK Kit for ETS-IR 04\C#\Libs\ReaderAPI.dll"),
    (Join-Path $RepoRoot "SDK Kit for ETS-IR 04\C#\Example\SampleCode\ReaderAPI.dll"),
    (Join-Path $RepoRoot "SDK Kit for ETS-IR 04\C#\Example\SampleCode\bin\Release\ReaderAPI.dll"),
    (Join-Path $RepoRoot "SDK Kit for ETS-IR 04\C#\Reader Demo Configuration Software\ReaderAPI.dll")
)

$SdkDll = $SdkDllCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($SdkDll) {
    New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
    Copy-Item -Force $SdkDll (Join-Path $LibDir "ReaderAPI.dll")
    Write-Host "Copied ReaderAPI.dll from SDK Kit: $SdkDll"
} elseif (Test-Path $LocalDll) {
    Write-Host "Using existing ReaderAPI.dll from rfid-bridge/lib."
} else {
    $force = $env:FORCE_RFID_BRIDGE_BUILD
    if ($force -and $force.ToLower() -eq "true") {
        throw "ReaderAPI.dll not found. Place the ETS-IR 04 SDK next to the app folder or copy ReaderAPI.dll to rfid-bridge\lib\."
    }

    Write-Warning "ReaderAPI.dll not found in SDK Kit or rfid-bridge\lib. Skipping rfid-bridge build."
    exit 0
}

$msbuild = $null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
}

if (-not $msbuild) {
    $msbuild = @(
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $msbuild) {
    $msbuild = @(
        "${env:ProgramFiles}\Microsoft Visual Studio\*\*\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\*\*\MSBuild\Current\Bin\MSBuild.exe"
    ) | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

if (-not $msbuild) {
    throw "MSBuild not found. Install Visual Studio Build Tools with .NET desktop development."
}

Write-Host "Using MSBuild: $msbuild"

& $msbuild (Join-Path $Root "rfid-bridge.csproj") /p:Configuration=Release /v:minimal
Write-Host "Built: $(Join-Path $Root 'bin\rfid-bridge.exe')"
