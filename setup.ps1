[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$WizardUrl = 'http://127.0.0.1:24023/'

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js 20 or newer is required.' -ForegroundColor Red
    Write-Host 'Install it from https://nodejs.org and run .\setup.ps1 again.' -ForegroundColor Yellow
    exit 1
}

$NodeMajor = [int]((& node.exe --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) { throw 'Node.js 20 or newer is required.' }

if (-not (Test-Path -LiteralPath (Join-Path $SetupDir 'node_modules\express'))) {
    Write-Host 'Installing local dependencies...' -ForegroundColor Cyan
    & npm.cmd install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}

$Existing = Get-NetTCPConnection -LocalPort 24023 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Existing) {
    $Wizard = Start-Process -FilePath 'node.exe' -ArgumentList @((Join-Path $SetupDir 'setup.mjs')) -WorkingDirectory $SetupDir -WindowStyle Hidden -PassThru
    $Deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $Deadline -and -not (Get-NetTCPConnection -LocalPort 24023 -State Listen -ErrorAction SilentlyContinue)) {
        if ($Wizard.HasExited) { throw 'The setup wizard could not start.' }
        Start-Sleep -Milliseconds 200
    }
}

Write-Host "Opening the secure local setup wizard at $WizardUrl" -ForegroundColor Green
Start-Process $WizardUrl
Write-Host 'Complete the browser wizard. The local setup service closes itself after you start Local Files MCP.' -ForegroundColor Yellow
