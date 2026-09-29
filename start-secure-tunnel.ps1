[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Keep the backend and tunnel under the signed-in user's token. Windows ACLs
# still govern file access; starting MCP does not require an administrator UAC.

. (Join-Path $PSScriptRoot 'scripts\disable-console-selection.ps1')

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

function Test-McpReady {
    try {
        $Body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 8 -Compress
        $Response = Invoke-RestMethod -Uri 'http://127.0.0.1:24024/mcp' -Method Post `
            -Headers @{ Accept = 'application/json, text/event-stream' } `
            -ContentType 'application/json' -Body $Body -TimeoutSec 3
        return ($Response.result.tools.Count -gt 0 -and -not $Response.error)
    } catch { return $false }
}

function Test-TunnelReady {
    try {
        $Response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24124/readyz' -TimeoutSec 2
        return ($Response.StatusCode -eq 200 -and $Response.Content.Trim().Trim('"') -eq 'ready')
    } catch { return $false }
}

# Re-running the launcher must not tear down a healthy backend/tunnel pair.
$BackendReady = Test-McpReady
$TunnelReady = Test-TunnelReady
if ($BackendReady -and $TunnelReady) {
    Write-Host 'READY: ForgeLink MCP and secure tunnel are already live.' -ForegroundColor Green
    Write-Host 'Dashboard: http://127.0.0.1:24025/dashboard/' -ForegroundColor Cyan
    exit 0
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$Server = $null
$TunnelClient = $null

if (-not $BackendReady) {
    & (Join-Path $SetupDir 'stop-previous-mcp.ps1') -BackendOnly
    Remove-Item -LiteralPath $ServerOut, $ServerErr -Force -ErrorAction SilentlyContinue
    $Server = Start-Process -FilePath 'node.exe' -ArgumentList @($ServerScript, '--public-url=http://localhost:24024', '--no-auth') -WorkingDirectory $SetupDir -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -WindowStyle Hidden -PassThru
}

try {
    if (-not $BackendReady) {
        $Deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $Deadline) {
            if ($Server.HasExited) { throw "Local MCP server exited. See $ServerErr" }
            $McpListener = Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $Server.Id }
            $DashboardListener = Get-NetTCPConnection -LocalPort 24025 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $Server.Id }
            if ($McpListener -and $DashboardListener -and (Test-McpReady)) { $BackendReady = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $BackendReady) { throw "Local MCP server did not open ports 24024 and 24025 or tools/list failed. See $ServerErr" }
    }

    if (-not $TunnelReady) {
        $Encrypted = (Get-Content -Raw -LiteralPath $KeyFile).Trim()
        $SecureKey = $Encrypted | ConvertTo-SecureString
        $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
        try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer); $SecureKey.Dispose() }

        Write-Host 'Checking the stable OpenAI Secure MCP Tunnel...' -ForegroundColor Green
        & $Client doctor --profile local-files --profile-dir $ProfileDir --explain
        if ($LASTEXITCODE -ne 0) { throw 'Secure MCP Tunnel health checks failed.' }
        Remove-Item -LiteralPath $TunnelOut, $TunnelErr -Force -ErrorAction SilentlyContinue
        $TunnelClient = Start-Process -FilePath $Client -ArgumentList @('run', '--profile', 'local-files', '--profile-dir', $ProfileDir, '--log.level', 'warn') -WorkingDirectory $SetupDir -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -WindowStyle Hidden -PassThru
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue

        $ReadyDeadline = (Get-Date).AddSeconds(30)
        $IsReady = $false
        while ((Get-Date) -lt $ReadyDeadline -and -not $TunnelClient.HasExited) {
            if (Test-TunnelReady) { $IsReady = $true; break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $IsReady) { throw "Secure MCP Tunnel did not become ready. See $TunnelErr" }
    }
    if ($Server -and $Server.HasExited) { throw "Local MCP server exited. See $ServerErr" }

    Write-Host 'READY: ForgeLink is connected through the permanent tunnel.' -ForegroundColor Green
    if ($TunnelClient) {
        $ConfiguredTunnel = ([regex]::Match((Get-Content -Raw -LiteralPath $ProfileFile), 'tunnel_id:\s*["'']?([^"''\r\n]+)')).Groups[1].Value.Trim()
        Write-Host "Tunnel: local-coding-files ($ConfiguredTunnel)"
    } else {
        Write-Host 'Using the already connected ForgeLink tunnel.'
    }
    Write-Host 'Dashboard: http://127.0.0.1:24025/dashboard/' -ForegroundColor Cyan
    if ($TunnelClient) {
        Write-Host 'Keep this window open. Press Ctrl+C to stop.' -ForegroundColor Yellow
        Wait-Process -Id $TunnelClient.Id
        exit $TunnelClient.ExitCode
    }
    exit 0
} finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    if ($TunnelClient -and -not $TunnelClient.HasExited) { Stop-Process -Id $TunnelClient.Id -Force }
    if ($Server -and -not $Server.HasExited -and $TunnelClient) { Stop-Process -Id $Server.Id -Force }
}
