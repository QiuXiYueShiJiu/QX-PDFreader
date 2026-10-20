# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 编译虚拟桌面启动器
#
# 用 dotnet publish 而不是直接调 csc：
#   直接 csc 编译不会生成 runtimeconfig.json，运行时报
#   "未能加载文件或程序集 System.Runtime, Version=10.0.0.0"。
#   publish 会一并产出 deps.json / runtimeconfig.json，才能正常启动。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $root 'tools\DesktopLauncher.csproj'
$pubDir = Join-Path $root 'tools\.publish'
$binDir = Join-Path $root 'tools\bin'

if (-not (Test-Path $proj)) { throw "project not found: $proj" }

if (Test-Path $pubDir) { Remove-Item $pubDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

& dotnet publish $proj -c Release -r win-x64 -o $pubDir --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }

Get-ChildItem $pubDir -File |
  Where-Object { $_.Extension -ne '.pdb' } |
  ForEach-Object { Copy-Item $_.FullName -Destination $binDir -Force }

$exe = Join-Path $binDir 'desktop-launcher.exe'
if (-not (Test-Path $exe)) { throw "desktop-launcher.exe missing" }

Write-Host "Built: $exe ($([math]::Round((Get-Item $exe).Length/1KB,1)) KB)"
