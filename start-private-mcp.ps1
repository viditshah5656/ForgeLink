[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Filesystem allowlists do not override Windows ACLs or integrity levels. Ask
# Windows for an explicit UAC approval so the backend can reach protected paths.
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentPrincipal = [Security.Principal.WindowsPrincipal]::new($CurrentIdentity)
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $PowerShellExe = Join-Path $PSHOME 'powershell.exe'
    $ElevatedArgs = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    try {
        $ElevatedProcess = Start-Process -FilePath $PowerShellExe -Verb RunAs -WindowStyle Normal -WorkingDirectory $PSScriptRoot -ArgumentList $ElevatedArgs -PassThru -Wait
    } catch {
        throw 'ForgeLink needs Windows administrator approval for full-computer access. Approve the UAC prompt and start it again.'
    }
    exit $ElevatedProcess.ExitCode
}

. (Join-Path $PSScriptRoot 'scripts\disable-console-selection.ps1')

$SetupDir = $PSScriptRoot
$ServerScript = Join-Path $SetupDir 'server.mjs'

& (Join-Path $SetupDir 'stop-previous-mcp.ps1')

Write-Host 'Starting private MCP server for OpenAI Secure MCP Tunnel...' -ForegroundColor Green
Write-Host 'Local MCP URL: http://127.0.0.1:24024/mcp'
& node $ServerScript '--public-url=http://localhost:24024' '--no-auth'
exit $LASTEXITCODE
