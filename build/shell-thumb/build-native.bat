@echo off
if not defined VCVARS set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul
cd /d "%~dp0"
cl /nologo /LD /EHsc /O2 /W3 QXThumbNative.cpp /link /OUT:QXThumbNative.dll windowscodecs.lib ole32.lib shlwapi.lib user32.lib gdi32.lib shell32.lib advapi32.lib