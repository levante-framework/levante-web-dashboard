@echo off
echo Starting Levante Dashboard with CORS Proxy...
echo This will handle PlayHT API calls without CORS issues
echo.
echo Dashboard will be available at: http://localhost:8001
echo.
python serve_cors.py
pause 