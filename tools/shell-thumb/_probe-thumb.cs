using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct SIZE { public int cx; public int cy; }

[ComImport]
[Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory
{
    void GetImage(SIZE size, int flags, out IntPtr phbm);
}

public static class Probe
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) { Console.WriteLine("usage: probe <file> <out.png>"); return 2; }
            Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
            IShellItemImageFactory factory;
            SHCreateItemFromParsingName(args[0], IntPtr.Zero, ref iid, out factory);
            IntPtr hbmp;
            factory.GetImage(new SIZE { cx = 256, cy = 256 }, 0x8 | 0x1, out hbmp);
            if (hbmp == IntPtr.Zero) { Console.WriteLine("no bitmap (provider returned null)"); return 1; }
            using (var bmp = Image.FromHbitmap(hbmp))
            {
                bmp.Save(args[1], ImageFormat.Png);
                Console.WriteLine("saved " + bmp.Width + "x" + bmp.Height);
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine("FAILED: " + ex.GetType().FullName);
            Console.WriteLine("message: " + ex.Message);
            Console.WriteLine("hresult: 0x" + ex.HResult.ToString("X8"));
            if (ex.InnerException != null) Console.WriteLine("inner: " + ex.InnerException.Message);
            return 3;
        }
    }
}
