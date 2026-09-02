param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$sourcePath = Join-Path $env:LOCALAPPDATA 'CodexWorkspaceCollector\config.json'
$targetDir = Join-Path $env:LOCALAPPDATA 'CWDevelopmentSync'
$targetPath = Join-Path $targetDir 'config.json'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Legacy collector configuration was not found' }
if (Test-Path -LiteralPath $targetPath -PathType Leaf) { throw 'CW Development Sync is already configured; migration did not overwrite it' }
$raw = Get-Content -LiteralPath $sourcePath -Raw
$hubMatch = [regex]::Match($raw, '"HubUrl"\s*:\s*"(?<value>https://[^"\\]+)"')
$keyMatch = [regex]::Match($raw, '"ProtectedKey"\s*:\s*"(?<value>[A-Za-z0-9+/=]+)"')
$deviceMatch = [regex]::Match($raw, '"DeviceId"\s*:\s*"(?<value>[a-zA-Z0-9._-]+)"')
if (-not $hubMatch.Success -or -not $keyMatch.Success -or -not $deviceMatch.Success) { throw 'Legacy configuration does not contain extractable connection settings' }
$hubUrl = $hubMatch.Groups['value'].Value
$protectedKey = $keyMatch.Groups['value'].Value
$deviceId = $deviceMatch.Groups['value'].Value.Trim().ToLowerInvariant()
if ($deviceId -notmatch '^[a-z0-9][a-z0-9._-]{2,63}$') { throw 'Legacy device name is invalid' }
$oldEntropy = [Text.Encoding]::UTF8.GetBytes('CodexWorkspaceCollector.Config.v1')
$newEntropy = [Text.Encoding]::UTF8.GetBytes('CWDevelopmentSync.Config.v1')
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($protectedKey), $oldEntropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
  $protectedKey = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $newEntropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
} finally {
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($oldEntropy, 0, $oldEntropy.Length)
  [Array]::Clear($newEntropy, 0, $newEntropy.Length)
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
@{
  schemaVersion = 1
  hubUrl = $hubUrl.Trim().TrimEnd('/')
  deviceId = $deviceId
  protectedSecret = $protectedKey
} | ConvertTo-Json | Set-Content -LiteralPath $targetPath -Encoding UTF8
Write-Host ('Migrated encrypted CW connection settings to ' + $targetPath)
Write-Host 'No project list, folder path, schedule, or sync strategy was migrated.'
