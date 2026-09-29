$ErrorActionPreference = 'Stop'
$Helper = Join-Path (Split-Path -Parent $PSScriptRoot) 'stop-previous-mcp.ps1'
$Root = Split-Path -Parent $PSScriptRoot
$ServerScript = Join-Path $Root 'server.mjs'
$TunnelClient = Join-Path $Root 'bin\tunnel-client.exe'
$ProfileDir = Join-Path $Root 'tunnel-client-data\profiles'

function Get-NetTCPConnection {
    [CmdletBinding()]
    param([int]$LocalPort, [string]$State)
    if ($global:MockListeners.ContainsKey($LocalPort)) {
        [pscustomobject]@{ OwningProcess = $global:MockListeners[$LocalPort] }
    }
}

function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    $PidNumber = [int]([regex]::Match($Filter, '\d+').Value)
    $global:MockProcesses[$PidNumber]
}

function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $global:Stopped += $Id
    foreach ($Port in @($global:MockListeners.Keys)) {
        if ($global:MockListeners[$Port] -eq $Id) { $global:MockListeners.Remove($Port) }
    }
}

$Server = [pscustomobject]@{ Name = 'node.exe'; CommandLine = "node.exe `"$ServerScript`" --no-auth"; ExecutablePath = 'C:\Program Files\nodejs\node.exe' }
$Tunnel = [pscustomobject]@{ Name = 'tunnel-client.exe'; CommandLine = "`"$TunnelClient`" run --profile local-files --profile-dir `"$ProfileDir`""; ExecutablePath = $TunnelClient }
$Other = [pscustomobject]@{ Name = 'other.exe'; CommandLine = 'other.exe'; ExecutablePath = 'C:\other.exe' }
$global:MockProcesses = @{ 101 = $Tunnel; 202 = $Server; 303 = $Other }

$global:MockListeners = @{ 24124 = 101; 24024 = 202; 24025 = 202 }
$global:Stopped = @()
& $Helper | Out-Null
if (($global:Stopped -join ',') -ne '101,202' -or $global:MockListeners.Count -ne 0) {
    throw 'Expected the old tunnel and server to stop and all three ports to clear.'
}

$global:MockListeners = @{ 24124 = 101; 24024 = 202; 24025 = 303 }
$global:Stopped = @()
$Rejected = $false
try { & $Helper | Out-Null } catch { $Rejected = $_.Exception.Message -like '*unrelated process*' }
if (-not $Rejected -or $global:Stopped.Count -ne 0) {
    throw 'An unrelated dashboard port owner must be rejected before stopping anything.'
}

$global:MockListeners = @{ 24025 = 202 }
$global:Stopped = @()
& $Helper | Out-Null
if (($global:Stopped -join ',') -ne '202' -or $global:MockListeners.Count -ne 0) {
    throw 'A server holding only the dashboard port must be stopped.'
}

Write-Output 'stop-previous-mcp: 3 scenarios passed'
