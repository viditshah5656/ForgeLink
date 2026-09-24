[CmdletBinding()]
param(
    [switch]$LocalOnly
)

if (-not $LocalOnly) {
    $StableLauncher = Join-Path $PSScriptRoot 'start-secure-tunnel.ps1'
    $StableProfile = Join-Path $PSScriptRoot 'tunnel-client-data\profiles\local-files.yaml'
    $StableKey = Join-Path $PSScriptRoot 'tunnel-client-data\api-key.dpapi'
    if ((Test-Path -LiteralPath $StableProfile) -and (Test-Path -LiteralPath $StableKey)) {
        & $StableLauncher
        exit $LASTEXITCODE
    }
    throw 'Changing trycloudflare URLs are disabled. Create an OpenAI tunnel and then run .\configure-secure-tunnel.ps1 once.'
}

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$EnvFile = Join-Path $SetupDir '.env'
$TunnelOut = Join-Path $SetupDir 'cloudflared.log'
$TunnelErr = Join-Path $SetupDir 'cloudflared.err.log'
$CurrentUrlFile = Join-Path $SetupDir '.current-tunnel-url'
$ServerScript = Join-Path $SetupDir 'server.mjs'

# Replace only a stale instance of this exact server. Never take a port from an
# unrelated process.
$PortOwner = Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PortOwner) {
    $OwnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($PortOwner.OwningProcess)" -ErrorAction SilentlyContinue
    $ExpectedScript = $ServerScript.Replace('\', '\\')
    if ($OwnerProcess.Name -eq 'node.exe' -and $OwnerProcess.CommandLine -like "*$ServerScript*") {
        Stop-Process -Id $OwnerProcess.ProcessId -Force
        $Deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $Deadline -and (Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 100
        }
    } else {
        throw "Port 24024 is already used by PID $($PortOwner.OwningProcess) ($($OwnerProcess.Name)). Refusing to stop an unrelated process."
    }
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
    $RandomBytes = [byte[]]::new(32)
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Rng.GetBytes($RandomBytes) } finally { $Rng.Dispose() }
    $Password = [Convert]::ToBase64String($RandomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    @(
        '# Keep this file private. Do not commit or share it.'
        'ALLOWED_ROOT=C:\Coding'
        'PORT=24024'
        "OAUTH_LOGIN_PASSWORD=$Password"
    ) | Set-Content -LiteralPath $EnvFile -Encoding utf8
}

$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $EnvFile '/inheritance:r' '/grant:r' "${Identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict permissions on .env' }

if ($LocalOnly) {
    & node $ServerScript '--public-url=http://localhost:24024'
    exit $LASTEXITCODE
}

Remove-Item -LiteralPath $TunnelOut, $TunnelErr, $CurrentUrlFile -Force -ErrorAction SilentlyContinue
$StaleTunnels = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tunnel --url http://127.0.0.1:24024*' }
foreach ($StaleTunnel in $StaleTunnels) { Stop-Process -Id $StaleTunnel.ProcessId -Force -ErrorAction SilentlyContinue }
$Tunnel = Start-Process -FilePath 'npx.cmd' -ArgumentList @('--yes', 'cloudflared', 'tunnel', '--url', 'http://127.0.0.1:24024', '--no-autoupdate') -WorkingDirectory $SetupDir -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -WindowStyle Hidden -PassThru

try {
    $Deadline = (Get-Date).AddSeconds(45)
    $PublicUrl = $null
    while ((Get-Date) -lt $Deadline -and -not $Tunnel.HasExited) {
        Start-Sleep -Milliseconds 500
        $Text = @()
        if (Test-Path -LiteralPath $TunnelOut) { $Text += Get-Content -Raw -LiteralPath $TunnelOut }
        if (Test-Path -LiteralPath $TunnelErr) { $Text += Get-Content -Raw -LiteralPath $TunnelErr }
        $Match = [regex]::Match(($Text -join "`n"), 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($Match.Success) { $PublicUrl = $Match.Value; break }
    }
    if (-not $PublicUrl) {
        $Details = if (Test-Path -LiteralPath $TunnelErr) { Get-Content -Raw -LiteralPath $TunnelErr } else { 'No cloudflared output.' }
        throw "Cloudflare quick tunnel did not produce a URL. $Details"
    }
    Set-Content -LiteralPath $CurrentUrlFile -Value $PublicUrl -Encoding ascii
    Write-Host "Public MCP URL: $PublicUrl/mcp" -ForegroundColor Green
    Write-Host "OAuth password is stored locally in $EnvFile" -ForegroundColor Yellow
    & node $ServerScript "--public-url=$PublicUrl"
} finally {
    if ($Tunnel -and -not $Tunnel.HasExited) { & taskkill.exe /PID $Tunnel.Id /T /F | Out-Null }
}
