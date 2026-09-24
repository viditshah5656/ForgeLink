[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^tunnel_[A-Za-z0-9]+$')]
    [string]$TunnelId
)

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$Client = Join-Path $SetupDir 'bin\tunnel-client.exe'
$DataDir = Join-Path $SetupDir 'tunnel-client-data'
$ProfileDir = Join-Path $DataDir 'profiles'
$KeyFile = Join-Path $DataDir 'api-key.dpapi'

if (-not (Test-Path -LiteralPath $Client)) { throw "tunnel-client is missing at $Client" }
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$ExistingKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'Process')
if ($ExistingKey -and $ExistingKey.Length -ge 20 -and $ExistingKey.StartsWith('sk-')) {
    $SecureKey = ConvertTo-SecureString $ExistingKey -AsPlainText -Force
    Write-Host 'Using the existing OPENAI_API_KEY from this process without printing it.' -ForegroundColor Yellow
} else {
    $SecureKey = Read-Host 'Paste the OpenAI runtime API key (input is hidden)' -AsSecureString
}
if ($SecureKey.Length -lt 20) { throw 'The runtime API key was empty or too short.' }
$SecureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $KeyFile -Encoding ascii

$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $KeyFile '/inheritance:r' '/grant:r' "${Identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict permissions on the encrypted API-key file.' }

& $Client init `
    --force `
    --sample sample_mcp_remote_no_auth `
    --profile local-files `
    --profile-dir $ProfileDir `
    --tunnel-id $TunnelId `
    --mcp-server-url 'http://127.0.0.1:24024/mcp' `
    --health-listen-addr '127.0.0.1:24124'
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client profile creation failed.' }

Write-Host 'Stable tunnel configuration saved.' -ForegroundColor Green
Write-Host 'Starting the stable tunnel now...' -ForegroundColor Green
& (Join-Path $SetupDir 'start-secure-tunnel.ps1')
exit $LASTEXITCODE
