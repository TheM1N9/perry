// Compiled by perry start with Windows' .NET Framework compiler, /target:winexe.
// Task Scheduler runs this GUI executable: neither it nor its console child allocates a console.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using Microsoft.Win32.SafeHandles;

class PerryLauncher
{
    const int MaxBytes = 1024 * 1024;
    static readonly object LogLock = new object();
    static string LogFile;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref JobLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    static void Log(string line)
    {
        lock (LogLock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
            byte[] bytes = Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("o") + " " + line + "\n");
            if (File.Exists(LogFile) && new FileInfo(LogFile).Length + bytes.Length > MaxBytes)
            {
                File.Delete(LogFile + ".3");
                for (int n = 2; n >= 0; n--)
                {
                    string from = LogFile + (n == 0 ? "" : "." + n);
                    if (File.Exists(from)) File.Move(from, LogFile + "." + (n + 1));
                }
            }
            using (var file = new FileStream(LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                file.Write(bytes, 0, bytes.Length);
        }
    }

    // Bound a line even if a broken child never writes a newline.
    static void Drain(StreamReader reader)
    {
        var line = new StringBuilder();
        int ch;
        while ((ch = reader.Read()) != -1)
        {
            if (ch == '\n') { if (line.Length > 0) { try { Log(line.ToString()); } catch (IOException) { } } line.Clear(); }
            else if (ch != '\r' && line.Length < 8192) line.Append((char)ch);
        }
        if (line.Length > 0) { try { Log(line.ToString()); } catch (IOException) { } }
    }

    static int Main()
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        LogFile = Path.GetFullPath(Path.Combine(directory, "..", "logs", "runner.log"));
        try
        {
            var config = new XmlDocument { XmlResolver = null };
            config.Load(Path.Combine(directory, "runner.xml"));
            LogFile = config.SelectSingleNode("/Launcher/LogFile").InnerText;
            // Also covers a repeated direct launch, outside Task Scheduler's IgnoreNew policy.
            bool created;
            using (var mutex = new Mutex(true, config.SelectSingleNode("/Launcher/Mutex").InnerText, out created))
            {
                if (!created) return 0;
                try
                {
                    var start = new ProcessStartInfo {
                        FileName = config.SelectSingleNode("/Launcher/Program").InnerText,
                        Arguments = config.SelectSingleNode("/Launcher/Arguments").InnerText,
                        WorkingDirectory = config.SelectSingleNode("/Launcher/WorkingDirectory").InnerText,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardInput = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };
                    foreach (XmlNode variable in config.SelectNodes("/Launcher/Environment/Variable"))
                        start.EnvironmentVariables[variable.Attributes["name"].Value] = variable.InnerText;
                    string pidFile = start.EnvironmentVariables["PERRY_SERVICE_PID_FILE"];
                    if (!String.IsNullOrEmpty(pidFile)) File.Delete(pidFile);
                    Log("[launcher] starting Perry");
                    using (var child = Process.Start(start))
                    using (var job = new SafeFileHandle(CreateJobObject(IntPtr.Zero, null), true))
                    {
                        // Closing this launcher (including Task Scheduler /End) cleans up only its own tree.
                        // The job handle is not inherited, so a crashed supervisor cannot leave orphan runners.
                        var limits = new JobLimits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE
                        if (job.IsInvalid || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))) || !AssignProcessToJobObject(job, child.Handle))
                        {
                            int error = Marshal.GetLastWin32Error();
                            child.Kill();
                            throw new Win32Exception(error, "Could not manage Perry's process tree");
                        }
                        if (!String.IsNullOrEmpty(pidFile)) File.WriteAllText(pidFile, child.Id + " " + child.StartTime.ToUniversalTime().Ticks);
                        child.StandardInput.Close();
                        var stdout = Task.Factory.StartNew(() => Drain(child.StandardOutput));
                        var stderr = Task.Factory.StartNew(() => Drain(child.StandardError));
                        child.WaitForExit();
                        Task.WaitAll(stdout, stderr);
                        Log("[launcher] Perry exited (" + child.ExitCode + ")");
                        return child.ExitCode;
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            try { Log("[launcher] could not start or supervise Perry: " + error.GetType().Name + ": " + error.Message); } catch { }
            return 1;
        }
    }
}
