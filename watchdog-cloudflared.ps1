[CmdletBinding()]
param(
    [int]$LocalPort = 24024,
    [ValidateSet('http2', 'quic')]
    [string]$Protocol = 'http2',
    [int]$HealthCheckIntervalSec = 10,
    [string]$OutputFile = '.current-tunnel-url'
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }

# 1. Resolve cloudflared binary
$CloudflaredBin = Join-Path $ScriptDir 'bin\cloudflared.exe'
if (-not (Test-Path -LiteralPath $CloudflaredBin)) {
    $Command = Get-Command 'cloudflared' -ErrorAction SilentlyContinue
    if ($Command) {
        $CloudflaredBin = $Command.Source
    } else {
        throw "cloudflared binary not found in $ScriptDir\bin or PATH."
    }
}

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Cloudflared Watchdog Service (Windows)        " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Binary:   $CloudflaredBin" -ForegroundColor Gray
Write-Host "Origin:   http://127.0.0.1:$LocalPort" -ForegroundColor Gray
Write-Host "Protocol: $Protocol" -ForegroundColor Gray
Write-Host "=================================================" -ForegroundColor Cyan

$CurrentUrlPath = Join-Path $ScriptDir $OutputFile
$LogOut = Join-Path $ScriptDir 'cloudflared.log'
$LogErr = Join-Path $ScriptDir 'cloudflared.err.log'

function Stop-StaleTunnels {
    $Stale = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*127.0.0.1:$LocalPort*" -or $_.CommandLine -like "*localhost:$LocalPort*" }
    foreach ($proc in $Stale) {
        Write-Host "Terminating stale cloudflared instance (PID $($proc.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$RestartCount = 0

try {
    while ($true) {
        # Check local origin readiness
        $OriginReady = $false
        try {
            $tcp = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($tcp) { $OriginReady = $true }
        } catch {}

        if (-not $OriginReady) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting for local service on port $LocalPort to start..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
            continue
        }

        Stop-StaleTunnels
        Remove-Item $LogOut, $LogErr -Force -ErrorAction SilentlyContinue

        $RestartCount++
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Starting cloudflared tunnel (Session #$RestartCount)..." -ForegroundColor Green

        $Process = Start-Process -FilePath $CloudflaredBin `
            -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$LocalPort", '--protocol', $Protocol, '--no-autoupdate') `
            -WorkingDirectory $ScriptDir `
            -RedirectStandardOutput $LogOut `
            -RedirectStandardError $LogErr `
            -PassThru `
            -WindowStyle Hidden

        # Wait for public URL to be assigned
        $TunnelUrl = $null
        $UrlDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $UrlDeadline -and -not $Process.HasExited) {
            Start-Sleep -Milliseconds 500
            $Combined = @()
            if (Test-Path $LogErr) { $Combined += Get-Content -Raw -LiteralPath $LogErr -ErrorAction SilentlyContinue }
            if (Test-Path $LogOut) { $Combined += Get-Content -Raw -LiteralPath $LogOut -ErrorAction SilentlyContinue }
            $Match = [regex]::Match(($Combined -join "`n"), 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($Match.Success) {
                $TunnelUrl = $Match.Value
                break
            }
        }

        if (-not $TunnelUrl -or $Process.HasExited) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Failed to establish tunnel or process died early." -ForegroundColor Red
            if (Test-Path $LogErr) {
                Get-Content $LogErr -Tail 10 | ForEach-Object { Write-Host "  CF Err: $_" -ForegroundColor DarkGray }
            }
            Write-Host "Backing off for 5 seconds before restart..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
            continue
        }

        # Save and display URL
        Set-Content -LiteralPath $CurrentUrlPath -Value $TunnelUrl -Encoding ascii
        Write-Host "=================================================" -ForegroundColor Green
        Write-Host "TUNNEL ONLINE: $TunnelUrl" -ForegroundColor Green
        Write-Host "MCP Endpoint:  $TunnelUrl/mcp" -ForegroundColor Green
        Write-Host "Saved to:      $CurrentUrlPath" -ForegroundColor Gray
        Write-Host "=================================================" -ForegroundColor Green
        Write-Host "Press Ctrl+C to stop watchdog.`n" -ForegroundColor DarkGray

        # Monitoring loop
        while (-not $Process.HasExited) {
            Start-Sleep -Seconds $HealthCheckIntervalSec

            if ($Process.HasExited) {
                break
            }

            # Local service liveness check
            $OriginAlive = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
            if (-not $OriginAlive) {
                Write-Warning "[$(Get-Date -Format 'HH:mm:ss')] Local origin port $LocalPort stopped listening!"
            }
        }

        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Cloudflared process (PID $($Process.Id)) terminated (ExitCode: $($Process.ExitCode))." -ForegroundColor Yellow
        Remove-Item -LiteralPath $CurrentUrlPath -Force -ErrorAction SilentlyContinue
        Write-Host "Restarting tunnel in 3 seconds..." -ForegroundColor Cyan
        Start-Sleep -Seconds 3
    }
} finally {
    Write-Host "`n[Watchdog] Shutting down cloudflared..." -ForegroundColor Yellow
    Stop-StaleTunnels
    Remove-Item -LiteralPath $CurrentUrlPath -Force -ErrorAction SilentlyContinue
    Write-Host "[Watchdog] Stopped cleanly." -ForegroundColor Gray
}
