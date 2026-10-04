param([Parameter(Mandatory=$true)][string]$Backup, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
function Get-PrivateHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path); $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
}
$source = [System.IO.Path]::GetFullPath($Backup)
$target = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Restore only into a new directory. No live data is overwritten.' }
$manifest = Get-Content -LiteralPath (Join-Path $source 'backup-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne 1) { throw 'Unsupported backup manifest.' }
foreach ($file in $manifest.files) {
  $path = [System.IO.Path]::GetFullPath((Join-Path $source $file.path))
  $destinationPath = [System.IO.Path]::GetFullPath((Join-Path $target $file.path))
  if (-not $path.StartsWith($source+'\', [StringComparison]::OrdinalIgnoreCase) -or -not $destinationPath.StartsWith($target+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup path escapes its directory.' }
  $item = Get-Item -LiteralPath $path
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup symlinks are not accepted.' }
  if ($item.Length -ne $file.size -or (Get-PrivateHash $path) -ne $file.sha256) { throw 'Backup hash or size mismatch.' }
}
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($file in $manifest.files) {
  $path = Join-Path $source $file.path; $dest = Join-Path $target $file.path
  New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
  Copy-Item -LiteralPath $path -Destination $dest
  if ((Get-PrivateHash $dest) -ne $file.sha256) { throw 'Restored file hash mismatch.' }
}
Write-Output "Restored to new directory: $target. Run offline admin verify before starting."
