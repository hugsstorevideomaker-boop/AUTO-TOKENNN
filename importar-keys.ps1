param(
  [Parameter(Mandatory = $true)]
  [string]$ArquivoKeys = ".\\keys.json"
)
$ErrorActionPreference = 'Stop'
if (-not $env:LICENSE_SERVER_URL) { throw 'Defina LICENSE_SERVER_URL, por exemplo https://seu-app.up.railway.app' }
if (-not $env:LICENSE_ADMIN_TOKEN) { throw 'Defina LICENSE_ADMIN_TOKEN no PowerShell.' }
if (-not (Test-Path $ArquivoKeys)) { throw "Arquivo nao encontrado: $ArquivoKeys" }
$keys = Get-Content -Raw -Path $ArquivoKeys | ConvertFrom-Json
$body = @{ keys = $keys } | ConvertTo-Json -Depth 100
$uri = $env:LICENSE_SERVER_URL.TrimEnd('/') + '/admin/keys/import'
$headers = @{ Authorization = "Bearer $($env:LICENSE_ADMIN_TOKEN)" }
$result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
Write-Host "Licencas importadas: $($result.imported)" -ForegroundColor Green
Write-Host "Ja existentes ignoradas: $($result.skipped)"
Write-Host "Total no servidor: $($result.total)"
