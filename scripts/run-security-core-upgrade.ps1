$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (Select-String -LiteralPath (Join-Path $root 'server.mjs') -Pattern 'ChatGptPermissionBroker' -SimpleMatch -Quiet) {
  Write-Host "This legacy upgrade is superseded by ForgeLink's ChatGPT permission broker. No policy or access configuration was changed." -ForegroundColor Yellow
  exit 1
}
Write-Host ""
Write-Host "ForgeLink protected security-core upgrade" -ForegroundColor Cyan
Write-Host "This removes standing drive-root access, downgrades Full Terminal to Guarded, fixes the Windows npm runner, and installs one-time filesystem capabilities."
Write-Host ""
$confirmation = Read-Host "Type exactly: APPLY FORGELINK SECURITY UPGRADE"
if ($confirmation -ne "APPLY FORGELINK SECURITY UPGRADE") {
  Write-Host "Cancelled. No protected files were changed." -ForegroundColor Yellow
  exit 1
}
$env:FORGELINK_LOCAL_SECURITY_MAINTENANCE = "1"
$env:FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT = [string]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + (5 * 60 * 1000))
try {
  & node.exe (Join-Path $PSScriptRoot "apply-security-core-upgrade.mjs") --apply
  if ($LASTEXITCODE -ne 0) { throw "Security-core upgrade failed with exit code $LASTEXITCODE" }
  Write-Host ""
  Write-Host "Protected files upgraded. Return to ChatGPT so ForgeLink can be restarted and verified." -ForegroundColor Green
} finally {
  Remove-Item Env:FORGELINK_LOCAL_SECURITY_MAINTENANCE -ErrorAction SilentlyContinue
  Remove-Item Env:FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT -ErrorAction SilentlyContinue
}
