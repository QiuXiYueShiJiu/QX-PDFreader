// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 在**独立虚拟桌面**上启动一个程序。
 *
 * 为什么需要它（教训）：
 *   之前所有 GUI 测试都直接把窗口开在用户的真实桌面上，
 *   结果窗口不断弹出、挡住视线，用户只能手动关掉 ——
 *   而我误判成「程序自己退出」，白白排查了很久。
 *   测试进程必须与人隔离，这是硬性要求。
 *
 * 原理：
 *   Windows 支持多桌面（与「任务视图」的虚拟桌面是同一套机制）。
 *   用 CreateDesktopW 建一个自己的桌面，再用 STARTUPINFO.lpDesktop
 *   把子进程放进去 —— 它的窗口只存在于那个桌面上，
 *   不会出现在用户桌面，也不会抢焦点。
 *
 * 注意：
 *   · 桌面上没有 Explorer，因此 Shell 相关 API 行为不同（本程序不依赖）
 *   · 截图需要用 PrintWindow（见 capture-desktop.ps1），
 *     BitBlt 只能抓当前活动桌面
 */

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class DesktopLauncher
{
    private const uint DESKTOP_CREATEWINDOW = 0x0002;
    private const uint DESKTOP_ENUMERATE = 0x0040;
    private const uint DESKTOP_WRITEOBJECTS = 0x0080;
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    private const uint GENERIC_ALL = 0x10000000;

    /** 不给子进程分配控制台 —— 避免弹出黑窗（用户明确要求） */
    private const uint CREATE_NO_WINDOW = 0x08000000;
    /*
     * 注意：不要加 DETACHED_PROCESS。
     * 它与 lpDesktop 一起用时会让 Electron 在非活动桌面上启动失败：
     * 进程被创建后立刻退出（CreateProcess 返回成功，但进程秒退），
     * 表现为「启动器日志正常、electron 进程数为 0」。
     * 只用 CREATE_NO_WINDOW 就足以避免控制台窗口。
     */

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(
        string lpszDesktop,
        string lpszDevice,
        IntPtr pDevmode,
        int dwFlags,
        uint dwDesiredAccess,
        ref SECURITY_ATTRIBUTES lpsa);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern int GetLastError();

    private static int Main(string[] args)
    {
        /*
         * 本程序是 WinExe（无控制台），因此**不能依赖 stdout 传状态** ——
         * 没有控制台时 Console 写入会被丢弃。所有进展与错误都写日志文件，
         * 调用方读文件获取结果。
         */
        string logPath = null;
        var argList = new System.Collections.Generic.List<string>();
        string desktopName = null;
        string exePath = null;
        bool wait = true;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--log" && i + 1 < args.Length) { logPath = args[++i]; continue; }
            if (args[i] == "--no-wait") { wait = false; continue; }
            if (desktopName == null) { desktopName = args[i]; continue; }
            if (exePath == null) { exePath = args[i]; continue; }
            argList.Add(args[i]);
        }

        if (desktopName == null || exePath == null)
        {
            Log(logPath, "error 用法: desktop-launcher.exe <桌面名> <可执行文件> [参数...] [--log 文件] [--no-wait]");
            return 2;
        }

        // 建桌面（已存在同名桌面时会返回已存在的句柄）
        var sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));

        IntPtr hDesktop = CreateDesktopW(
            desktopName,
            null,
            IntPtr.Zero,
            0,
            DESKTOP_CREATEWINDOW | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS |
            DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP | GENERIC_ALL,
            ref sa);

        if (hDesktop == IntPtr.Zero)
        {
            Log(logPath, "error CreateDesktop 失败，错误码 " + GetLastError());
            return 3;
        }

        // 命令行要按 Windows 规则拼：含空格的参数必须加引号
        var cmd = new StringBuilder();
        cmd.Append('"').Append(exePath).Append('"');
        foreach (var a in argList)
        {
            cmd.Append(' ');
            if (a.Contains(" ") || a.Contains("\t"))
            {
                cmd.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
            }
            else
            {
                cmd.Append(a);
            }
        }

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        // ★ 关键一：把子进程绑到新桌面
        si.lpDesktop = desktopName;

        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(
            null,               // 从命令行解析可执行文件
            cmd,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            // ★ 关键二：不给子进程控制台（但不要用 DETACHED_PROCESS，见文件顶部说明）
            CREATE_NO_WINDOW,
            IntPtr.Zero,
            null,               // 继承当前工作目录
            ref si,
            out pi);

        if (!ok)
        {
            Log(logPath, "error CreateProcess 失败，错误码 " + GetLastError());
            CloseDesktop(hDesktop);
            return 4;
        }

        Log(logPath, "ok pid=" + pi.dwProcessId + " desktop=" + desktopName);

        if (wait)
        {
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            Log(logPath, "child-exited");
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseDesktop(hDesktop);
        return 0;
    }

    /** 追加一行到日志文件（WinExe 没有控制台，只能这样回报状态） */
    private static void Log(string path, string message)
    {
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            System.IO.File.AppendAllText(
                path,
                DateTime.Now.ToString("HH:mm:ss") + " " + message + Environment.NewLine,
                Encoding.UTF8);
        }
        catch { /* 日志失败不影响主流程 */ }
    }
}
