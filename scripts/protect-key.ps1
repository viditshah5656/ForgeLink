[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$PlainKey = [Console]::In.ReadToEnd().Trim()
if (-not $PlainKey.StartsWith('sk-') -or $PlainKey.Length -lt 20) { throw 'Invalid runtime API key.' }
$SecureKey = ConvertTo-SecureString $PlainKey -AsPlainText -Force
$SecureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $OutputPath -Encoding ascii
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $OutputPath '/inheritance:r' '/grant:r' "${Identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict permissions on the encrypted key.' }
