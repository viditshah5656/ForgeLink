[CmdletBinding()]
param(
    [switch]$LocalOnly,
    [switch]$QuickPublic,
    [switch]$Stop,
    [string]$BootstrapFile
)

if (-not $Stop -and -not $LocalOnly -and -not $QuickPublic) {
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

# The desktop's localhost-only backend runs under the signed-in user's token;
# folder permissions still follow Windows ACLs. Public tunnel modes continue
# to require explicit elevation for full-computer access.
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentPrincipal = [Security.Principal.WindowsPrincipal]::new($CurrentIdentity)
if (-not ($LocalOnly -or $Stop) -and -not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $PowerShellExe = Join-Path $PSHOME 'powershell.exe'
    $ElevatedArgs = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    if ($LocalOnly) { $ElevatedArgs += ' -LocalOnly' }
    if ($QuickPublic) { $ElevatedArgs += ' -QuickPublic' }
    if ($Stop) { $ElevatedArgs += ' -Stop' }
    if ($BootstrapFile) { $ElevatedArgs += (' -BootstrapFile "{0}"' -f $BootstrapFile.Replace('"', '""')) }
    $ElevatedWindowStyle = if ($LocalOnly -or $Stop) { 'Hidden' } else { 'Normal' }
    try {
        $ElevatedProcess = Start-Process -FilePath $PowerShellExe -Verb RunAs -WindowStyle $ElevatedWindowStyle -WorkingDirectory $PSScriptRoot -ArgumentList $ElevatedArgs -PassThru -Wait
    } catch {
        throw 'ForgeLink needs Windows administrator approval for full-computer access. Approve the UAC prompt and start it again.'
    }
    exit $ElevatedProcess.ExitCode
}

if ($BootstrapFile) {
    if (-not (Test-Path -LiteralPath $BootstrapFile)) { throw 'ForgeLink runtime bootstrap data was not found.' }
    $Bootstrap = Get-Content -LiteralPath $BootstrapFile -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($Property in $Bootstrap.PSObject.Properties) {
        if ($null -ne $Property.Value) {
            Set-Item -Path ("Env:" + $Property.Name) -Value ([string]$Property.Value)
        }
    }
    Remove-Item -LiteralPath $BootstrapFile -Force -ErrorAction SilentlyContinue
}

$SetupDir = $PSScriptRoot
$DisableSelectionScript = Join-Path $SetupDir 'scripts\disable-console-selection.ps1'
if (($LocalOnly -or $QuickPublic) -and (Test-Path -LiteralPath $DisableSelectionScript)) {
    . $DisableSelectionScript
}
$EnvFile = if ($env:FORGELINK_ENV_FILE) { $env:FORGELINK_ENV_FILE } elseif ($env:MCP_DATA_DIR) { Join-Path $env:MCP_DATA_DIR '.env' } else { Join-Path $SetupDir '.env' }
$TunnelOut = Join-Path $SetupDir 'cloudflared.log'
$TunnelErr = Join-Path $SetupDir 'cloudflared.err.log'
$CurrentUrlFile = Join-Path $SetupDir '.current-tunnel-url'
$ServerScript = if ($env:FORGELINK_SERVER_SCRIPT) {
    [IO.Path]::GetFullPath($env:FORGELINK_SERVER_SCRIPT)
} elseif (Test-Path -LiteralPath (Join-Path $SetupDir 'server.mjs')) {
    Join-Path $SetupDir 'server.mjs'
} elseif (Test-Path -LiteralPath (Join-Path $SetupDir 'backend-entry.mjs')) {
    Join-Path $SetupDir 'backend-entry.mjs'
} else {
    throw 'ForgeLink backend entry script was not found.'
}
$env:FORGELINK_SERVER_SCRIPT = $ServerScript
$NodeExe = if ($env:FORGELINK_NODE_EXE) { [IO.Path]::GetFullPath($env:FORGELINK_NODE_EXE) } else { 'node' }

$StopScript = Join-Path $SetupDir 'stop-previous-mcp.ps1'
if ($Stop) {
    & $StopScript -BackendOnly
    exit $LASTEXITCODE
}
if ($LocalOnly) {
    & $StopScript -BackendOnly
} else {
    & $StopScript
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
    $ServerArgs = @($ServerScript, '--public-url=http://localhost:24024')
    if ($env:FORGELINK_SERVER_OUT -and $env:FORGELINK_SERVER_ERR) {
        $ServerOut = $env:FORGELINK_SERVER_OUT
        $ServerErr = $env:FORGELINK_SERVER_ERR
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ServerOut) | Out-Null
        & $NodeExe @ServerArgs 1>> $ServerOut 2>> $ServerErr
    } else {
        & $NodeExe @ServerArgs
    }
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
