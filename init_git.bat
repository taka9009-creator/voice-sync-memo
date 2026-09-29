@echo off
set GIT="C:\Users\user\AppData\Local\GitHubDesktop\app-3.6.6\resources\app\git\cmd\git.exe"
%GIT% config user.name "takayan"
%GIT% config user.email "takayan@example.com"
%GIT% add .
%GIT% commit -m "Initial commit: Voice Library"
%GIT% status
