# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

# Read-only snapshot of the foreground window + top-level windows of one process.
#
# WHY THIS EXISTS (do not "simplify" it back into list-windows.ps1):
#   list-windows.ps1 skips every window whose title is empty
#   (`if (title.Length === 0) return true;`). The window the user reported on
#   2026-10-15 ("a blank window with no title bar popped up in the foreground")
#   is a *frameless* window (src/main/index.ts:227 `frame: false`) that has not
#   painted yet -- i.e. exactly an untitled window. The old tool therefore could
#   not see the reported shape at all, which is why that report stayed open.
#
# This script never calls ShowWindow / SetForegroundWindow: it only reads
# GetForegroundWindow / EnumWindows / IsWindowVisible, so running it cannot
# change what the user sees.
#
# Output: one pipe-delimited record per line (title is last, may contain "|").
#   FG|<hwnd>|<pid>|<visible>|<w>x<h>|<class>|<title>
#   W|<hwnd>|<pid>|<visible>|<w>x<h>|<class>|<title>
#   -- totals: <all top-level>|<visible>|<matched>   (always the last line)
#
# The counts matter: "no W lines" must be distinguishable from "EnumWindows saw
# nothing at all", otherwise a broken probe reads exactly like a clean desktop.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless a BOM
# is present, so non-ASCII comments here would be mojibake (or worse: a parse
# error) when the file is written as plain UTF-8.

# NOTE: the parameter must NOT be called -Pid: PowerShell variable names are
# case-insensitive, so a parameter named $Pid collides with the read-only
# automatic variable $PID and the whole script fails at parameter binding.
param([int]$ProcessId = 0)

$ErrorActionPreference = 'Stop'

# Titles must survive as UTF-8. Windows PowerShell 5.1 otherwise encodes stdout
# with the ANSI code page (GBK here), and the Node side (encoding: 'utf8') turns
# the Chinese dialog title into mojibake -- which made verify-native-dialogs fail
# its "dialog title matches" assertion on 2026-10-18 although the dialog itself
# was correct. Purely an output concern: nothing here changes what is on screen.
# (ASCII-only on purpose, like the rest of this file -- see the header note.)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FgSnapshot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  static FgSnapshot() { SetProcessDPIAware(); }

  static string Title(IntPtr h) { var t = new StringBuilder(512); GetWindowTextW(h, t, 512); return t.ToString(); }
  static string Cls(IntPtr h) { var t = new StringBuilder(256); GetClassNameW(h, t, 256); return t.ToString(); }

  public static string Line(string tag, IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return tag + "|" + ((long)h) + "|" + pid + "|" + (IsWindowVisible(h) ? "true" : "false")
      + "|" + (r.R - r.L) + "x" + (r.B - r.T) + "|" + Cls(h) + "|" + Title(h);
  }

  // Every top-level window, with its real visibility flag. No title filter:
  // the reported "blank, untitled" window is precisely the one a title filter drops.
  public static string[] Survey() {
    var rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      rows.Add(Line("W", h));
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  public static string Foreground() { return Line("FG", GetForegroundWindow()); }
}
'@

$fg = [FgSnapshot]::Foreground()
$all = [FgSnapshot]::Survey()

$visible = 0
$matched = 0
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add($fg)

foreach ($row in $all) {
  $parts = $row.Split('|')
  $rowPid = [int]$parts[2]
  $rowVisible = $parts[3] -eq 'true'
  if ($rowVisible) { $visible++ }
  if ($ProcessId -ne 0 -and $rowPid -ne $ProcessId) { continue }
  if ($ProcessId -eq 0 -and -not $rowVisible) { continue }
  $matched++
  $lines.Add($row)
}

$lines.Add("--|$($all.Count)|$visible|$matched")
Write-Output ($lines -join "`n")
