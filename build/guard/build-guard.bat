@echo off
rem 编译守护进程：Windows 自带的 .NET Framework 编译器，不需要装 Visual Studio。
rem 用法：双击本文件，或在 build\guard 目录下执行 build-guard.bat
if not exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
  echo [x] 找不到 csc.exe，请确认系统装有 .NET Framework 4.x
  exit /b 1
)
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /out:QiuXiGuard.exe QiuXiGuard.cs
if errorlevel 1 (
  echo [x] 编译失败
  exit /b 1
)
echo [ok] 已生成 QiuXiGuard.exe
