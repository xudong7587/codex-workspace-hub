@echo off
setlocal
pushd "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" exit /b 2
if not exist dist mkdir dist
"%CSC%" /nologo /target:winexe /optimize+ /win32manifest:app.manifest /out:dist\CodexWorkspaceCollector.exe /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll Program.cs CollectorConfig.cs HubClient.cs UsageScanner.cs SyncEngine.cs
set BUILD_EXIT=%ERRORLEVEL%
popd
exit /b %BUILD_EXIT%
