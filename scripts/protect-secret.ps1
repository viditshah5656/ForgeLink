[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
$Secret = [Console]::In.ReadToEnd().Trim()
if ($Secret.Length -lt 20) { throw 'The secret is empty or too short.' }

$Secure = ConvertTo-SecureString $Secret -AsPlainText -Force
$Secure | ConvertFrom-SecureString | Set-Content -LiteralPath $Destination -Encoding ascii
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $Destination '/inheritance:r' '/grant:r' "${Identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict secret-file permissions.' }
