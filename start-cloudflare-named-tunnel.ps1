[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Hostname,

    [string]$TunnelToken,

    [switch]$UseSavedToken
)

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$SecretTool = Join-Path $SetupDir 'scripts\protect-secret.ps1'
$TokenFile = Join-Path $SetupDir 'cloudflare-tunnel-token.dpapi'
$PlainTokenFile = Join-Path $SetupDir 'tunnel-client-data\cloudflare-token.txt'
$ServerScript = Join-Path $SetupDir 'server.mjs'

if (-not $Hostname.Contains('.')) { throw 'Use a full hostname, for example mcp.example.com.' }
if (-not $UseSavedToken -and $TunnelToken.Length -lt 20) { throw 'The Cloudflare tunnel token is too short.' }
if ($UseSavedToken -and -not (Test-Path -LiteralPath $TokenFile)) { throw 'No saved Cloudflare tunnel token was found. Complete the local setup wizard first.' }

$TunnelProcesses = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$PlainTokenFile*" }
foreach ($Process in $TunnelProcesses) { Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue }
$HealthOwner = Get-NetTCPConnection -LocalPort 24124 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($HealthOwner) {
    $HealthProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($HealthOwner.OwningProcess)" -ErrorAction SilentlyContinue
    if ($HealthProcess.Name -eq 'tunnel-client.exe' -and $HealthProcess.CommandLine -like '*--profile*local-files*') { Stop-Process -Id $HealthOwner.OwningProcess -Force }
}
$PortOwner = Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PortOwner) {
    $ServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($PortOwner.OwningProcess)" -ErrorAction SilentlyContinue
    if ($ServerProcess.Name -eq 'node.exe' -and $ServerProcess.CommandLine -like "*$ServerScript*") { Stop-Process -Id $PortOwner.OwningProcess -Force }
    else { throw "Port 24024 is used by an unrelated process." }
}

if (-not $UseSavedToken) { $TunnelToken | & $SecretTool -Destination $TokenFile }
$Encrypted = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
$Secure = $Encrypted | ConvertTo-SecureString
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
try { $PlainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PlainTokenFile) | Out-Null
Set-Content -LiteralPath $PlainTokenFile -Value $PlainToken -NoNewline -Encoding ascii
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $PlainTokenFile '/inheritance:r' '/grant:r' "${Identity}:(F)" | Out-Null

try {
    $Server = Start-Process -FilePath 'node.exe' -ArgumentList @($ServerScript, "--public-url=https://$Hostname") -WorkingDirectory $SetupDir -WindowStyle Hidden -PassThru
    $Deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $Deadline -and -not (Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
    if (-not (Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue)) { throw 'Local MCP server did not start.' }
    Write-Host "Starting permanent Cloudflare tunnel for https://$Hostname/mcp" -ForegroundColor Green
    & npx.cmd --yes cloudflared tunnel --no-autoupdate run --token-file $PlainTokenFile
} finally {
    Remove-Item -LiteralPath $PlainTokenFile -Force -ErrorAction SilentlyContinue
    if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -Force }
}
