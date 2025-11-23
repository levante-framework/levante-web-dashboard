#!/usr/bin/env pwsh
# Levante Pitwall Deployment Script

Write-Host "🚀 Deploying Levante Pitwall to Vercel..." -ForegroundColor Cyan
Write-Host ""

# Deploy to production
Write-Host "[1/3] Deploying to production..." -ForegroundColor Yellow
$deployResult = & vercel --prod 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ ERROR: Deployment failed!" -ForegroundColor Red
    Write-Host $deployResult -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Extract deployment URL from output
$deploymentUrl = ($deployResult | Select-String -Pattern "https://web-dashboard-[a-zA-Z0-9]+-digitalpros-projects\.vercel\.app").Matches.Value
if (-not $deploymentUrl) {
    Write-Host "❌ ERROR: Could not extract deployment URL!" -ForegroundColor Red
    Write-Host $deployResult -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "✅ Deployment successful: $deploymentUrl" -ForegroundColor Green
Write-Host ""

# Set up aliases
Write-Host "[2/3] Setting up aliases..." -ForegroundColor Yellow
$aliases = @(
    "audio-dashboard-levante.vercel.app",
    "levante-audio-dashboard.vercel.app"
)

foreach ($alias in $aliases) {
    Write-Host "  Setting alias: $alias" -ForegroundColor Gray
    $aliasResult = & vercel alias set $deploymentUrl $alias 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ⚠️  Warning: Failed to set alias $alias" -ForegroundColor Yellow
        Write-Host "  $aliasResult" -ForegroundColor Yellow
    } else {
        Write-Host "  ✅ Alias set successfully" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[3/3] Verifying aliases..." -ForegroundColor Yellow
& vercel alias list | Select-String -Pattern "audio-dashboard.*levante|levante.*audio.*dashboard"

Write-Host ""
Write-Host "🎉 Deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 Your dashboard is now available at:" -ForegroundColor Cyan
Write-Host "  • https://audio-dashboard-levante.vercel.app" -ForegroundColor White
Write-Host "  • https://levante-pitwall.vercel.app" -ForegroundColor White
Write-Host "  • $deploymentUrl" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to exit" 