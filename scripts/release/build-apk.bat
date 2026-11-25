@echo off
set "JAVA_HOME=C:\Java\jdk-21.0.13.1+2"
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "C:\Users\TestUser\Downloads\CAPRI AI\capri-desktop\android"
call gradlew.bat assembleRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease > "%TEMP%\build-apk.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "%TEMP%\build-apk.log"
