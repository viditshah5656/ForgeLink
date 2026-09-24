[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $PSScriptRoot
$ForbiddenTracked = @('.env', 'access-config.json', '.oauth-clients.json', 'openai-tunnel.env')
$Tracked = @(git -C $Project ls-files)
$Failures = [System.Collections.Generic.List[string]]::new()

foreach ($Name in $ForbiddenTracked) {
    if ($Tracked -contains $Name) { $Failures.Add("Secret-bearing local file is tracked: $Name") }
}
foreach ($Path in $Tracked) {
    if ($Path -match '^(bin|tunnel-client-data)/' -or $Path -match '\.(log|zip|png)$') { $Failures.Add("Generated or downloaded artifact is tracked: $Path") }
}

$Patterns = @(
    'sk-[A-Za-z0-9_-]{20,}',
    'gh[opsu]_[A-Za-z0-9_]{20,}',
    'tunnel_[A-Za-z0-9]{20,}',
    'OAUTH_LOGIN_PASSWORD=[^\s]+'
)
foreach ($Pattern in $Patterns) {
    foreach ($Path in $Tracked) {
        if ($Path -in @('README.md', 'scripts/security-audit.ps1', 'setup.mjs', 'setup-web/setup.js', 'configure-secure-tunnel.ps1', 'show-oauth-password.ps1', 'start-mcp.ps1')) { continue }
        $FullPath = Join-Path $Project $Path
        if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) { continue }
        $Hits = @(Select-String -LiteralPath $FullPath -Pattern $Pattern -AllMatches -ErrorAction SilentlyContinue)
        foreach ($Hit in $Hits) { $Failures.Add("Potential credential found in $Path at line $($Hit.LineNumber)") }
    }
}

if ($Failures.Count) {
    Write-Host 'SECURITY AUDIT FAILED — nothing should be pushed yet.' -ForegroundColor Red
    $Failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host 'SECURITY AUDIT PASSED — no tracked credentials or generated local artifacts found.' -ForegroundColor Green
