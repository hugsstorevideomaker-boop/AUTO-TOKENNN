param(
  [Parameter(Mandatory = $true)]
  [string]$OrderId,
  [string]$Note = "Venda Auto Token"
)
$ErrorActionPreference = 'Stop'
if (-not $env:LICENSE_SERVER_URL) { throw 'Defina LICENSE_SERVER_URL.' }
if (-not $env:LICENSE_ADMIN_TOKEN) { throw 'Defina LICENSE_ADMIN_TOKEN.' }
$uri = $env:LICENSE_SERVER_URL.TrimEnd('/') + '/admin/keys'
$headers = @{ Authorization = "Bearer $($env:LICENSE_ADMIN_TOKEN)" }
$body = @{ orderId = $OrderId; note = $Note } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body
Write-Host "Chave: $($result.key)" -ForegroundColor Green
if ($result.alreadyIssued) { Write-Host 'Esta chave ja havia sido emitida para esse pedido.' -ForegroundColor Yellow }
