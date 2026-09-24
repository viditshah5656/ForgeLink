[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$Client = Join-Path $SetupDir 'bin\tunnel-client.exe'
$ServerScript = Join-Path $SetupDir 'server.mjs'
$DataDir = Join-Path $SetupDir 'tunnel-client-data'
$ProfileDir = Join-Path $DataDir 'profiles'
$ProfileFile = Join-Path $ProfileDir 'local-files.yaml'
$KeyFile = Join-Path $DataDir 'api-key.dpapi'
$ServerOut = Join-Path $DataDir 'server.log'
$ServerErr = Join-Path $DataDir 'server.err.log'
$TunnelOut = Join-Path $DataDir 'tunnel.log'
$TunnelErr = Join-Path $DataDir 'tunnel.err.log'

if (-not (Test-Path -LiteralPath $ProfileFile)) { throw 'Run .\configure-secure-tunnel.ps1 -TunnelId tunnel_... first.' }
if (-not (Test-Path -LiteralPath $KeyFile)) { throw 'The encrypted runtime API key is missing. Run configure-secure-tunnel.ps1 again.' }

# Replace only a prior tunnel client for this same local-files profile. This
# lets an upgraded server reconnect without touching unrelated tunnel clients.
$HealthOwner = Get-NetTCPConnection -LocalPort 24124 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($HealthOwner) {
    $HealthProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($HealthOwner.OwningProcess)" -ErrorAction SilentlyContinue
    if ($HealthProcess.Name -eq 'tunnel-client.exe' -and $HealthProcess.CommandLine -like '*--profile*local-files*') {
        Stop-Process -Id $HealthProcess.ProcessId -Force
        $HealthDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $HealthDeadline -and (Get-NetTCPConnection -LocalPort 24124 -State Listen -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 100
        }
    } else {
        throw "Port 24124 is already used by PID $($HealthOwner.OwningProcess) ($($HealthProcess.Name)). Refusing to stop an unrelated process."
    }
}

$PortOwner = Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PortOwner) {
    $OwnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($PortOwner.OwningProcess)" -ErrorAction SilentlyContinue
    if ($OwnerProcess.Name -eq 'node.exe' -and $OwnerProcess.CommandLine -like "*$ServerScript*") {
        Stop-Process -Id $OwnerProcess.ProcessId -Force
    } else {
        throw "Port 24024 is already used by PID $($PortOwner.OwningProcess) ($($OwnerProcess.Name))."
    }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Remove-Item -LiteralPath $ServerOut, $ServerErr -Force -ErrorAction SilentlyContinue
$Server = Start-Process -FilePath 'node.exe' -ArgumentList @($ServerScript, '--public-url=http://localhost:24024', '--no-auth') -WorkingDirectory $SetupDir -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -WindowStyle Hidden -PassThru

try {
    $Deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $Deadline -and -not (Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue)) {
        if ($Server.HasExited) { throw "Local MCP server exited. See $ServerErr" }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue)) { throw 'Local MCP server did not become ready.' }

    $Encrypted = (Get-Content -Raw -LiteralPath $KeyFile).Trim()
    $SecureKey = $Encrypted | ConvertTo-SecureString
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
    try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }

    Write-Host 'Checking the stable OpenAI Secure MCP Tunnel...' -ForegroundColor Green
    & $Client doctor --profile local-files --profile-dir $ProfileDir --explain
    if ($LASTEXITCODE -ne 0) { throw 'Secure MCP Tunnel health checks failed.' }
    Remove-Item -LiteralPath $TunnelOut, $TunnelErr -Force -ErrorAction SilentlyContinue
    $TunnelClient = Start-Process -FilePath $Client -ArgumentList @('run', '--profile', 'local-files', '--profile-dir', $ProfileDir, '--log.level', 'warn') -WorkingDirectory $SetupDir -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -WindowStyle Hidden -PassThru
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue

    $ReadyDeadline = (Get-Date).AddSeconds(30)
    $IsReady = $false
    while ((Get-Date) -lt $ReadyDeadline -and -not $TunnelClient.HasExited) {
        try {
            $ReadyResponse = Invoke-RestMethod 'http://127.0.0.1:24124/readyz' -TimeoutSec 2
            if ($ReadyResponse -eq 'ready') { $IsReady = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (-not $IsReady) { throw "Secure MCP Tunnel did not become ready. See $TunnelErr" }

    Write-Host 'READY: Local Files is connected through the permanent tunnel.' -ForegroundColor Green
    $ConfiguredTunnel = ([regex]::Match((Get-Content -Raw -LiteralPath $ProfileFile), 'tunnel_id:\s*["'']?([^"''\r\n]+)')).Groups[1].Value.Trim()
    Write-Host "Tunnel: local-coding-files ($ConfiguredTunnel)"
    Write-Host 'Dashboard: http://127.0.0.1:24025/dashboard/' -ForegroundColor Cyan
    Write-Host 'Keep this window open. Press Ctrl+C to stop.' -ForegroundColor Yellow
    Wait-Process -Id $TunnelClient.Id
    exit $TunnelClient.ExitCode
} finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    if ($TunnelClient -and -not $TunnelClient.HasExited) { Stop-Process -Id $TunnelClient.Id -Force }
    if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -Force }
}
