using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class Program
{
    static string FlagPath;
    static string ExePath;
    static int ParentPid;
    static int Restarts = 0;

    static int Main(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--pid") int.TryParse(args[i + 1], out ParentPid);
            if (args[i] == "--exe") ExePath = args[i + 1];
            if (args[i] == "--flag") FlagPath = args[i + 1];
        }
        if (ParentPid <= 0 || string.IsNullOrEmpty(ExePath)) return 2;

        bool created;
        using (var mutex = new Mutex(true, "QiuXi.PDFReader.Guard.Single", out created))
        {
            if (!created) return 0;
            while (true)
            {
                Thread.Sleep(1500);
                bool alive = true;
                try { var p = Process.GetProcessById(ParentPid); alive = !p.HasExited; }
                catch { alive = false; }

                if (alive) continue;
                if (FlagPath != null && File.Exists(FlagPath)) return 0;
                if (Restarts >= 2) return 0;
                Restarts++;
                try
                {
                    var psi = new ProcessStartInfo(ExePath);
                    psi.UseShellExecute = false;
                    psi.WorkingDirectory = Path.GetDirectoryName(ExePath);
                    var np = Process.Start(psi);
                    if (np != null) ParentPid = np.Id;
                }
                catch { return 3; }
            }
        }
    }
}