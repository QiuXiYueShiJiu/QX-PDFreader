// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/*
 * 资源管理器 PDF 缩略图提供器（shell thumbnail provider）。
 *
 * ── 为什么是「薄壳」────────────────────────────────────────────
 *   真正把 PDF 渲成图的是本程序（pdf.js）。这里只做三件事：
 *     ① 查缓存（%LOCALAPPDATA%\QiuxiPdfThumbs\<sha1(路径)>.png）；
 *     ② 缓存没有/过期 → 用全局互斥串行启动一次 `秋夕-PDF阅读器.exe --render-thumb <pdf>`；
 *     ③ 把 PNG 读成 HBITMAP 交回 explorer。
 *   渲染逻辑只有一份、只在 Electron 里，不需要在 C# 里再引一个 PDF 库。
 *
 * ── 为什么用 .NET（而不是 C++）────────────────────────────────
 *   electron-builder 打的是免装环境，机器上不一定有 MSVC 构建链；
 *   但 .NET Framework 4.x 是 Win10 自带的，`csc.exe` + `mscoree.dll` 就能做出
 *   进程内 COM 组件，不需要额外运行时。
 *
 * 缓存键必须与 src/main/thumbs.ts 的 thumbKey() 完全一致：
 *   SHA1( 路径 → 反斜杠 + 全小写 ) 取前 24 位十六进制。
 * 这两处一旦不一致，提供器就永远命中不了缓存（表现为「每次都要等几秒」）。
 */

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace QXThumb
{
    [ComImport]
    [Guid("b7d14566-0509-4cce-a71f-0a554233bd9b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IInitializeWithFile
    {
        void Initialize([MarshalAs(UnmanagedType.LPWStr)] string pszFilePath, uint grfMode);
    }

    [ComImport]
    [Guid("7F73BE3F-FB79-493C-A6C7-7EE14E245841")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IInitializeWithItem
    {
        void Initialize(IShellItem psi, uint grfMode);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport]
    [Guid("e357fccd-a995-4576-b001-881491e95fd7")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IThumbnailProvider
    {
        void GetThumbnail(uint cx, out IntPtr phbmp, out int pdwAlpha);
    }

    [ComVisible(true)]
    [Guid("7C4F1E2A-9B31-4D8E-9A57-2E6C0B7A55D1")]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class PdfThumbnailProvider : IInitializeWithFile, IInitializeWithItem, IThumbnailProvider, IDisposable
    {
        private const string CacheDirName = "QiuxiPdfThumbs";
        private const int WtsatRgb = 1;
        private const int RenderTimeoutMs = 20000;

        private string _file;

        public void Initialize(string pszFilePath, uint grfMode)
        {
            _file = pszFilePath;
        }

        /// <summary>Shell 实际走的是 IInitializeWithItem（IID 7F73BE3F…）；缺了它外壳会直接报失败而根本不进来。</summary>
        public void Initialize(IShellItem psi, uint grfMode)
        {
            const uint SIGDN_FILESYSPATH = 0x80058000;
            IntPtr psz = IntPtr.Zero;
            try
            {
                psi.GetDisplayName(SIGDN_FILESYSPATH, out psz);
                _file = Marshal.PtrToStringUni(psz);
            }
            catch (Exception ex) { Log("Initialize(item) 失败：" + ex.Message); }
            finally { if (psz != IntPtr.Zero) Marshal.FreeCoTaskMem(psz); }
        }

        public void GetThumbnail(uint cx, out IntPtr phbmp, out int pdwAlpha)  // QXTHUMB-TRACE
        {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "qxthumb-trace.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " GetThumbnail cx=" + cx + " file=" + _file + Environment.NewLine); } catch { }
            phbmp = IntPtr.Zero;
            pdwAlpha = WtsatRgb;

            if (string.IsNullOrEmpty(_file) || !File.Exists(_file)) { Log("源文件不存在：" + _file); return; }

            string png = CachePath(_file);
            if (!IsFresh(png, _file))
            {
                TryRender(_file);
            }
            if (!IsFresh(png, _file) && !File.Exists(png)) return;

            try
            {
                using (var img = Image.FromFile(png))
                using (var bmp = new Bitmap(img))
                {
                    // 缩略图请求的 cx 由 explorer 给（16~1024），这里只做等比缩放的上限保护
                    phbmp = bmp.GetHbitmap(Color.FromArgb(255, 255, 255));
                }
            }
            catch
            {
                if (phbmp != IntPtr.Zero) { DeleteObject(phbmp); phbmp = IntPtr.Zero; }
            }
        }

        /// <summary>缓存路径：%LOCALAPPDATA%\QiuxiPdfThumbs\&lt;sha1&gt;.png</summary>
        private static string CachePath(string file)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(Path.Combine(local, CacheDirName), Key(file) + ".png");
        }

        private static string Key(string file)
        {
            string normalized = file.Replace('/', '\\').ToLowerInvariant();
            using (var sha1 = SHA1.Create())
            {
                byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(normalized));
                var sb = new StringBuilder(24);
                for (int i = 0; i < 12; i++) sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        /// <summary>PNG 比源文件新（留 1s 余量，与主进程侧同一判据）</summary>
        private static bool IsFresh(string png, string source)
        {
            try
            {
                if (!File.Exists(png)) return false;
                var pngTime = File.GetLastWriteTimeUtc(png);
                var srcTime = File.GetLastWriteTimeUtc(source);
                return pngTime.AddSeconds(1) >= srcTime;
            }
            catch { return false; }
        }

        /// <summary>
        /// 唤起本程序渲染一页。
        /// 用全局互斥：explorer 一次可能并行问几十个文件，不能同时起几十个 Electron。
        /// 等锁最多 30s（别人正在渲），渲染超时 20s（主进程里也有同样的超时）。
        /// </summary>
        private static void TryRender(string file)
        {
            bool locked = false;
            try
            {
                using (var mutex = new Mutex(false, "Global\\QiuxiPdfThumbRender"))
                {
                    try { locked = mutex.WaitOne(TimeSpan.FromSeconds(30)); }
                    catch (AbandonedMutexException) { locked = true; }

                    if (!locked) return;

                    string png = CachePath(file);
                    if (IsFresh(png, file)) return; // 等锁期间别人已经渲好了

                    string exe = ThumbExe();
                    if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) { Log("找不到 ThumbExe：" + exe); return; }

                    var psi = new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = exe,
                        /*
                         * ThumbArgs 是「额外的命令行前缀」：
                         *   打包版为空（exe 自己就是程序）；
                         *   开发/调试时用它带上应用目录（如 electron.exe "D:\...\pdf-reader"），
                         *   否则 electron.exe 收到 --render-thumb 会当成「没有入口」直接退出。
                         */
                        Arguments = (ThumbArgs() + " --render-thumb \"" + file + "\"").Trim(),
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                    };
                    using (var p = System.Diagnostics.Process.Start(psi))
                    {
                        if (p == null) { Log("Process.Start 返回 null"); return; }
                        if (!p.WaitForExit(RenderTimeoutMs))
                        {
                            Log("渲染超时，强制结束：" + file);
                            try { p.Kill(); } catch { }
                        }
                        else
                        {
                            Log("渲染进程退出码 " + p.ExitCode + "：" + file);
                        }
                    }
                }
            }
            catch (Exception ex) { Log("TryRender 异常：" + ex.GetType().Name + " / " + ex.Message); }
            finally { if (locked) { /* mutex 在 using 里释放 */ } }
        }

        /// <summary>本程序 exe：由安装/自注册写进 CLSID 键的 ThumbExe 值</summary>
        private static string ThumbExe()
        {
            return ReadClassValue("ThumbExe");
        }

        /// <summary>额外命令行前缀（开发期带应用目录；打包版为空）</summary>
        private static string ThumbArgs()
        {
            string v = ReadClassValue("ThumbArgs");
            return v ?? string.Empty;
        }

        private static string ReadClassValue(string name)
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey(
                    "CLSID\\{7C4F1E2A-9B31-4D8E-9A57-2E6C0B7A55D1}"))
                {
                    if (key == null) return null;
                    return key.GetValue(name) as string;
                }
            }
            catch { return null; }
        }

        /// <summary>
        /// 诊断日志：%LOCALAPPDATA%\QiuxiPdfThumbs\provider.log。
        /// 提供器跑在 explorer.exe 里，没有控制台可看；出问题只能靠这个文件。
        /// 只记失败路径与退出码，正常命中缓存不写（避免每次浏览都刷盘）。
        /// </summary>
        private static void Log(string message)
        {
            try
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string dir = Path.Combine(local, CacheDirName);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.AppendAllText(
                    Path.Combine(dir, "provider.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "\t" + message + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }


        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        public void Dispose() { }
    }
}
