[CmdletBinding()]
param()

$DashboardUrl = 'http://127.0.0.1:24025/dashboard/'
try {
    $Response = Invoke-WebRequest -Uri $DashboardUrl -Method Head -UseBasicParsing -TimeoutSec 2
    if ($Response.StatusCode -ge 400) { throw "Dashboard returned HTTP $($Response.StatusCode)." }
} catch {
    throw 'ForgeLink is not running. Start .\start-mcp.ps1 first, then run this command again.'
}

Start-Process $DashboardUrl
