# CutMuck local dev (Windows)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/dev.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = Join-Path $root "apps\worker\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "Creating worker venv..."
  python -m venv (Join-Path $root "apps\worker\.venv")
  & $py -m pip install -r (Join-Path $root "apps\worker\requirements.txt")
}

if (-not (Test-Path (Join-Path $root "apps\web\node_modules"))) {
  Write-Host "Installing web deps..."
  npm --prefix (Join-Path $root "apps\web") install
}

Write-Host "Starting worker on :8787 (no --reload in this script — safer for uploads)"
Start-Process -FilePath $py -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8787" -WorkingDirectory (Join-Path $root "apps\worker")

Start-Sleep -Seconds 2
Write-Host "Starting Next.js on :3000"
npm --prefix (Join-Path $root "apps\web") run dev
