@echo off
echo Deploying to Vercel with default alias...
echo.

REM Deploy to production
vercel --prod > deployment.tmp

REM Extract the deployment URL from the output
for /f "tokens=3" %%i in ('findstr "Production:" deployment.tmp') do set DEPLOYMENT_URL=%%i

REM Clean up the URL (remove any brackets or extra characters)
set DEPLOYMENT_URL=%DEPLOYMENT_URL:[=%
set DEPLOYMENT_URL=%DEPLOYMENT_URL:]=%

echo Deployment URL: %DEPLOYMENT_URL%
echo.

REM Set the default alias
echo Setting default alias...
vercel alias set %DEPLOYMENT_URL% web-dashboard-digitalpros-projects.vercel.app

echo.
echo ✅ Deployment complete!
echo Default URL: https://web-dashboard-digitalpros-projects.vercel.app
echo Latest URL: %DEPLOYMENT_URL%

REM Clean up
del deployment.tmp 2>nul

pause 