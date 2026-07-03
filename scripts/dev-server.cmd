@echo off
rem Garante o Node 22 (instalado por usuario) na frente do PATH,
rem sobrepondo o Node 14 antigo do sistema.
set "PATH=%LOCALAPPDATA%\Programs\node22;%PATH%"
npm run dev -w server
