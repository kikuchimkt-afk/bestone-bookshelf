@echo off
echo =============================================
echo   📚 本のデータベース サーバー起動中...
echo =============================================
echo.
echo ブラウザで http://localhost:5500 を開いてください
echo 終了するにはこのウィンドウを閉じてください
echo.
cd /d "%~dp0"
npx -y live-server public --port=5500
pause
