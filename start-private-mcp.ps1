[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SetupDir = $PSScriptRoot
$ServerScript = Join-Path $SetupDir 'server.mjs'

$PortOwner = Get-NetTCPConnection -LocalPort 24024 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PortOwner) {
    $OwnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($PortOwner.OwningProcess)" -ErrorAction SilentlyContinue
    if ($OwnerProcess.Name -eq 'node.exe' -and $OwnerProcess.CommandLine -like "*$ServerScript*") {
        Stop-Process -Id $OwnerProcess.ProcessId -Force
    } else {
        throw "Port 24024 is already used by PID $($PortOwner.OwningProcess) ($($OwnerProcess.Name)). Refusing to stop an unrelated process."
    }
}

Write-Host 'Starting private MCP server for OpenAI Secure MCP Tunnel...' -ForegroundColor Green
Write-Host 'Local MCP URL: http://127.0.0.1:24024/mcp'
& node $ServerScript '--public-url=http://localhost:24024' '--no-auth'
exit $LASTEXITCODE
