$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
$src = Join-Path $here "dials"
$dest = Join-Path $env:APPDATA "Ulanzi\UlanziDeck\Plugins\com.ulanzi.claudeeffort.ulanziPlugin"
$exe = Join-Path $here "bin\deckkeys.exe"
$source = Join-Path $here "deckkeys.cs"

if (-not (Test-Path $exe) -or (Get-Item $exe).LastWriteTime -lt (Get-Item $source).LastWriteTime) {
  New-Item -ItemType Directory -Force (Join-Path $here "bin") | Out-Null
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /target:exe "/out:$exe" $source
  if ($LASTEXITCODE -ne 0) { throw "deckkeys.cs did not compile" }
}
if (-not (Test-Path (Join-Path $src "plugin\node_modules\ws"))) {
  Push-Location (Join-Path $src "plugin")
  try { npm install --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
  finally { Pop-Location }
}

if (Test-Path $dest) {
  $aside = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
  New-Item -ItemType Directory $aside | Out-Null
  Move-Item $dest $aside
}
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $src "*") $dest
New-Item -ItemType Directory -Force (Join-Path $dest "plugin\bin") | Out-Null
Copy-Item -Force $exe (Join-Path $dest "plugin\bin\deckkeys.exe")
"installed: $dest"
"restart Ulanzi Studio to load it"
