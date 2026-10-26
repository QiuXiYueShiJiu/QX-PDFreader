using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr phbm); }
[StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int x,int y){cx=x;cy=y;} }
[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem { void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); void GetParent(out IntPtr ppsi); void GetDisplayName(int sigdnName, out IntPtr ppszName); void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs); void Compare(IntPtr psi, uint hint, out int piOrder); }
static class P {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [STAThread] static void Main(string[] a) {
    var iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    object o; SHCreateItemFromParsingName(a[0], IntPtr.Zero, ref iid, out o);
    var f = (IShellItemImageFactory)o;
    IntPtr hbmp;
    try { f.GetImage(new SIZE(256,256), 8, out hbmp); }
    catch (Exception ex) { Console.WriteLine("FAIL " + ex.Message); return; }
    using (var bmp = Image.FromHbitmap(hbmp)) { bmp.Save(a[1], ImageFormat.Png); Console.WriteLine("OK " + bmp.Width + "x" + bmp.Height); }
    DeleteObject(hbmp);
  }
}