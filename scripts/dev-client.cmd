@echo off
rem Garante o Node 22 (instalado por usuario) na frente do PATH,
rem sobrepondo o Node 14 antigo do sistema. Caminho absoluto porque
rem %LOCALAPPDATA% pode nao existir no ambiente que spawna este script.
set "PATH=C:\Users\rodrigosouza\AppData\Local\Programs\node22;%PATH%"
call npm run dev -w client-web
