param([switch]$CancelRunning, [string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$data = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $root 'data' }
$control = Join-Path $data 'local-control.json'
if (-not (Test-Path -LiteralPath $control)) { throw 'This service was not started with local control. Do not kill unknown processes.' }
$env:XINGJIAN_DATA_DIR = $data
$commandArgs = @((Join-Path $root 'dist\server\index.mjs'), 'control', 'stop')
if ($CancelRunning) { $commandArgs += '--cancel-running' }
& node.exe @commandArgs
if ($LASTEXITCODE -ne 0) { throw 'Stop refused. Pause tasks first, or explicitly use -CancelRunning.' }
for ($i=0; $i -lt 120; $i++) {
  if (-not (Test-Path -LiteralPath (Join-Path $data 'runtime.lock'))) { Write-Output 'Service stopped; SQLite and source profiles closed.'; return }
  Start-Sleep -Milliseconds 500
}
throw 'Shutdown not finished after 60 seconds. Keep data unchanged and inspect the logs.'
