[CmdletBinding()]
param(
    [switch]$BackendOnly
)

$ErrorActionPreference = 'Stop'
$ServerScript = if ($env:FORGELINK_SERVER_SCRIPT) {
    [IO.Path]::GetFullPath($env:FORGELINK_SERVER_SCRIPT)
} elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'server.mjs')) {
    Join-Path $PSScriptRoot 'server.mjs'
} else {
    Join-Path $PSScriptRoot 'backend-entry.mjs'
}
$TunnelClient = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bin\tunnel-client.exe')) {
    Join-Path $PSScriptRoot 'bin\tunnel-client.exe'
} else {
    Join-Path $PSScriptRoot 'tunnel-client.exe'
}
$ProfileDir = Join-Path $PSScriptRoot 'tunnel-client-data\profiles'
$NodeExe = if ($env:FORGELINK_NODE_EXE) { [IO.Path]::GetFullPath($env:FORGELINK_NODE_EXE) } else { $null }
$ServerArgument = '(?:^|[\s"])' + [regex]::Escape($ServerScript) + '(?=$|[\s"])'
$PortsToCheck = if ($BackendOnly) { @(24024, 24025) } else { @(24124, 24024, 24025) }

# Validate every occupied port before stopping anything. A different app may
# use one of these ports, and its process must be left alone.
$Owners = @()
foreach ($Port in $PortsToCheck) {
    $Listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($Listener in $Listeners) {
        $Owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
        $IsServer = $Owner -and (
            ($Owner.CommandLine -match $ServerArgument -and ($Owner.Name -eq 'node.exe' -or ($NodeExe -and $Owner.ExecutablePath -ieq $NodeExe))) -or
            ($Owner.Name -in @('node.exe', 'electron.exe') -and ($Owner.CommandLine -like '*--type=utility*' -or $Owner.CommandLine -match $ServerArgument -or -not $Owner.CommandLine))
        )
        $IsTunnel = $Owner -and $Owner.Name -eq 'tunnel-client.exe' -and
            $Owner.ExecutablePath -ieq $TunnelClient -and
            $Owner.CommandLine -and
            $Owner.CommandLine.IndexOf('--profile local-files', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $Owner.CommandLine.IndexOf($ProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (($Port -eq 24124 -and -not $IsTunnel) -or ($Port -ne 24124 -and -not $IsServer)) {
            throw "Port $Port is used by PID $($Listener.OwningProcess) ($($Owner.Name)). Refusing to stop an unrelated process."
        }
        if (-not ($Owners | Where-Object { $_.ProcessId -eq $Listener.OwningProcess })) {
            $Owners += [pscustomobject]@{ ProcessId = $Listener.OwningProcess; Kind = $(if ($IsTunnel) { 'tunnel' } else { 'server' }) }
        }
    }
}

foreach ($Owner in @($Owners | Where-Object Kind -eq 'tunnel') + @($Owners | Where-Object Kind -eq 'server')) {
    Write-Host "Stopping previous ForgeLink $($Owner.Kind) (PID $($Owner.ProcessId))..." -ForegroundColor Yellow
    Stop-Process -Id $Owner.ProcessId -Force -ErrorAction SilentlyContinue
}

$Deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $Deadline) {
    $BusyPorts = @()
    foreach ($Port in $PortsToCheck) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $BusyPorts += $Port }
    }
    if (-not $BusyPorts.Count) { break }
    Start-Sleep -Milliseconds 100
}
foreach ($Port in $PortsToCheck) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port did not become free. ForgeLink was not started."
    }
}
