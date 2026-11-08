using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
[ComImport, Guid("b7d14566-0509-4cce-a71f-0a554233bd9b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IInitWithFile { void Initialize([MarshalAs(UnmanagedType.LPWStr)] string path, uint mode); }
[ComImport, Guid("e357fccd-a995-4576-b001-881491e95fd7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IThumbProvider { void GetThumbnail(uint cx, out IntPtr phbmp, out int palpha); }
static class T { [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
 [STAThread] static void Main(string[] a) {
  try {
    var t = Type.GetTypeFromCLSID(new Guid("7C4F1E2A-9B31-4D8E-9A57-2E6C0B7A55D1"), true);
    object o = Activator.CreateInstance(t);
    var init = (IInitWithFile)o; init.Initialize(a[0], 0);
    var tp = (IThumbProvider)o; IntPtr hb; int al;
    tp.GetThumbnail(256, out hb, out al);
    if (hb == IntPtr.Zero) { Console.WriteLine("GetThumbnail returned zero"); return; }
    using (var bmp = Image.FromHbitmap(hb)) { bmp.Save(a[1], ImageFormat.Png); Console.WriteLine("OK " + bmp.Width + "x" + bmp.Height + " alpha=" + al); }
    DeleteObject(hb);
  } catch (Exception ex) { Console.WriteLine("FAIL " + ex.GetType().Name + ": " + ex.Message + (ex.InnerException != null ? " / " + ex.InnerException.Message : "")); }
 } }