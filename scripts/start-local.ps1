$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $root 'dist\server\index.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm.cmd run build in the project first.' }
if (Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 4318 is occupied; no second process was started.' }
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$env:HOST = '127.0.0.1'
$env:PORT = '4318'
$env:XINGJIAN_DATA_DIR = $data
$env:XINGJIAN_PUBLIC_URL = 'http://127.0.0.1:4318'
$env:XINGJIAN_LOCAL_CONTROL = '1'
$node = (Get-Command node.exe).Source
$proc = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'stdout.log') -RedirectStandardError (Join-Path $data 'stderr.log') -PassThru
@{ pid = $proc.Id; executable = $node; entry = $entry; started_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data 'local-process.json') -Encoding utf8
Write-Output "Local service PID $($proc.Id); URL http://127.0.0.1:4318; logs: $data"
