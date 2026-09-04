@echo off
setlocal
pushd "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" exit /b 2
if not exist dist mkdir dist
"%CSC%" /nologo /target:exe /optimize+ /out:dist\CWIconBuilder.exe /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll IconBuilder.cs
if errorlevel 1 goto :done
dist\CWIconBuilder.exe assets\icon-source.png assets\cw-usage-reporter.png assets\cw-usage-reporter.ico
if errorlevel 1 goto :done
del /q dist\CWIconBuilder.exe
"%CSC%" /nologo /target:winexe /optimize+ /win32manifest:app.manifest /win32icon:assets\cw-usage-reporter.ico /out:dist\CWUsageReporter.exe /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll Program.cs SettingsForm.cs ReporterConfig.cs HubClient.cs UsageScanner.cs
:done
set BUILD_EXIT=%ERRORLEVEL%
popd
exit /b %BUILD_EXIT%
