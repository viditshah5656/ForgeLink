$Line = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env') | Where-Object { $_ -like 'OAUTH_LOGIN_PASSWORD=*' }
if (-not $Line) { throw 'Run start-mcp.ps1 once to create the credential file.' }
$Line.Substring('OAUTH_LOGIN_PASSWORD='.Length)
