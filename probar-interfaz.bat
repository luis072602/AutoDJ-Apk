@echo off
rem Abre la interfaz de la app en el navegador del PC para ver cambios sin compilar el APK.
rem Las cuentas son de prueba (no tocan Supabase). Para cerrar, cierra la ventana negra del servidor.
cd /d "%~dp0"
start "Servidor de pruebas AutoDJ" py dev_server.py 8095
timeout /t 2 /nobreak >nul
start "" "http://localhost:8095/?cuentas=prueba"
