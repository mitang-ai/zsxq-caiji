param([Parameter(Mandatory=$true)][string]$Destination, [string]$DataDirectory, [switch]$IncludeUnsealedOfflineProfiles)
$ErrorActionPreference = 'Stop'
function Get-PrivateHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path); $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
}
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { [System.IO.Path]::GetFullPath((Join-Path $root 'data')) }
$target = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath (Join-Path $source 'workbench.sqlite'))) { throw 'Existing database not found.' }
if ($target -eq $source -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup must be outside the live data directory.' }
if (Test-Path -LiteralPath $target) { throw 'Destination must be a new directory; no existing backup is overwritten.' }
$lock = Join-Path $source 'runtime.lock'
if (Test-Path -LiteralPath $lock) {
  $info = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
  if (Get-Process -Id $info.pid -ErrorAction SilentlyContinue) { throw 'Stop the service before making a cold backup.' }
}
if (Test-Path -LiteralPath (Join-Path $source 'profiles')) {
  if ((Get-ChildItem -LiteralPath (Join-Path $source 'profiles') -Directory -Force) -and -not $IncludeUnsealedOfflineProfiles) { throw 'Unsealed source profiles remain. Gracefully close source connections before backing up. For audited crash recovery only, use -IncludeUnsealedOfflineProfiles after verifying profile browser processes have stopped.' }
}
if (Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Data symlinks are not accepted for backup.' }
New-Item -ItemType Directory -Path $target | Out-Null
$skip = @('runtime.lock','local-process.json','local-control.json','stdout.log','stderr.log','control.sock')
foreach ($item in Get-ChildItem -LiteralPath $source -Force) { if ($skip -notcontains $item.Name) { Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse } }
$manifest = @(Get-ChildItem -LiteralPath $target -File -Recurse -Force | ForEach-Object { @{path=$_.FullName.Substring($target.Length+1); size=$_.Length; sha256=(Get-PrivateHash $_.FullName)} })
$json = @{version=1;created_at=(Get-Date).ToUniversalTime().ToString('o');files=$manifest} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $target 'backup-manifest.json'), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output "Cold backup verified by manifest: $target. It contains private data and the credential encryption key; keep it private."
