@echo off
setlocal
pushd "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist dist mkdir dist
"%CSC%" /nologo /target:exe /out:dist\ReporterSmoke.exe /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll ..\test\reporter-smoke.cs ReporterConfig.cs HubClient.cs UsageScanner.cs AccountUsageClient.cs
if errorlevel 1 goto :done
dist\ReporterSmoke.exe %*
:done
set BUILD_EXIT=%ERRORLEVEL%
popd
exit /b %BUILD_EXIT%
