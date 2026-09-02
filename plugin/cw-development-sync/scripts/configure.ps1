param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$configDir = Join-Path $env:LOCALAPPDATA 'CWDevelopmentSync'
$configPath = Join-Path $configDir 'config.json'
$hubUrl = (Read-Host 'CW HTTPS root address (for example https://cw.example.com)').Trim().TrimEnd('/')
if ($hubUrl -notmatch '^https://') { throw 'CW address must use HTTPS' }
$deviceId = (Read-Host ('Device name [' + $env:COMPUTERNAME.ToLowerInvariant() + ']')).Trim().ToLowerInvariant()
if (-not $deviceId) { $deviceId = $env:COMPUTERNAME.ToLowerInvariant() }
if ($deviceId -notmatch '^[a-z0-9][a-z0-9._-]{2,63}$') { throw 'Device name is invalid' }
$secret = Read-Host 'CW device connection Key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
  $entropy = [Text.Encoding]::UTF8.GetBytes('CWDevelopmentSync.Config.v1')
  $protectedSecret = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($entropy, 0, $entropy.Length)
  $plain = $null
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
@{
  schemaVersion = 1
  hubUrl = $hubUrl
  deviceId = $deviceId
  protectedSecret = $protectedSecret
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host ('Saved encrypted CW configuration to ' + $configPath)
