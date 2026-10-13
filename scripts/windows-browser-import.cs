// One-shot, owner-only IPC helper. No files are written and no credentials go to stdout.
// The dashboard launches it with ShellExecute/runas only after explicit import consent.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Collections.Generic;

class PerryBrowserImport {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out long luid);
    [StructLayout(LayoutKind.Sequential, Pack=4)] struct Privilege { public uint count; public long luid; public uint attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref Privilege privilege, uint size, IntPtr old, IntPtr needed);
    [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] static extern int NCryptOpenStorageProvider(out IntPtr provider, string name, uint flags);
    [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] static extern int NCryptOpenKey(IntPtr provider, out IntPtr key, string name, uint legacy, uint flags);
    [DllImport("ncrypt.dll")] static extern int NCryptDecrypt(IntPtr key, byte[] input, int inputSize, IntPtr padding, byte[] output, int outputSize, out int resultSize, uint flags);
#if PERRY_IMPORT_FIXTURE
    [DllImport("ncrypt.dll")] static extern int NCryptEncrypt(IntPtr key, byte[] input, int inputSize, IntPtr padding, byte[] output, int outputSize, out int resultSize, uint flags);
    static byte[] FixtureCngWrap(byte[] input) {
        return SystemContext(()=> {
            IntPtr provider=IntPtr.Zero,key=IntPtr.Zero;
            try {
                if(NCryptOpenStorageProvider(out provider,"Microsoft Software Key Storage Provider",0)!=0 || NCryptOpenKey(provider,out key,"Google Chromekey1",0,0)!=0) throw new Exception();
                int size; if(NCryptEncrypt(key,input,input.Length,IntPtr.Zero,null,0,out size,0x40)!=0 || size!=32) throw new Exception();
                byte[] output=new byte[size];if(NCryptEncrypt(key,input,input.Length,IntPtr.Zero,output,size,out size,0x40)!=0) {Clear(output);throw new Exception();}return output;
            } finally {if(key!=IntPtr.Zero)NCryptFreeObject(key);if(provider!=IntPtr.Zero)NCryptFreeObject(provider);}
        });
    }
#endif
    [DllImport("ncrypt.dll")] static extern int NCryptFreeObject(IntPtr handle);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=131072 };
    static byte[] Unprotect(byte[] data) { return ProtectedData.Unprotect(data, null, DataProtectionScope.CurrentUser); }
    static byte[] Slice(byte[] bytes, int start, int size) { if (start<0 || size<0 || start>bytes.Length-size) throw new Exception(); byte[] result=new byte[size]; Buffer.BlockCopy(bytes,start,result,0,size); return result; }
    static void Clear(byte[] bytes) { if(bytes!=null) Array.Clear(bytes,0,bytes.Length); }
    static T SystemContext<T>(Func<T> work) {
        IntPtr processToken=IntPtr.Zero, systemToken=IntPtr.Zero, duplicate=IntPtr.Zero;
        try {
            if(!OpenProcessToken(Process.GetCurrentProcess().Handle,0x28,out processToken)) throw new Exception();
            long luid; if(!LookupPrivilegeValue(null,"SeDebugPrivilege",out luid)) throw new Exception();
            Privilege privilege=new Privilege { count=1,luid=luid,attributes=2 };
            if(!AdjustTokenPrivileges(processToken,false,ref privilege,0,IntPtr.Zero,IntPtr.Zero) || Marshal.GetLastWin32Error()!=0) throw new Exception();
            // Use a SYSTEM service token. Never inspect LSASS or read another process's memory.
            foreach(Process process in Process.GetProcessesByName("winlogon")) {
                using(process) {
                    if(process.SessionId!=Process.GetCurrentProcess().SessionId) continue;
                    IntPtr handle=OpenProcess(0x1000,false,process.Id);
                    if(handle==IntPtr.Zero) continue;
                    try { if(OpenProcessToken(handle,0xA,out systemToken)) break; }
                    finally { CloseHandle(handle); }
                }
            }
            if(systemToken==IntPtr.Zero || !DuplicateTokenEx(systemToken,0xE,IntPtr.Zero,2,2,out duplicate)) throw new Exception();
            using(WindowsImpersonationContext context=WindowsIdentity.Impersonate(duplicate)) {
                if(WindowsIdentity.GetCurrent().User.Value!="S-1-5-18") throw new Exception();
                return work();
            }
        } finally { if(duplicate!=IntPtr.Zero)CloseHandle(duplicate); if(systemToken!=IntPtr.Zero)CloseHandle(systemToken); if(processToken!=IntPtr.Zero)CloseHandle(processToken); }
    }
    static byte[] Cng(byte[] encrypted) {
        return SystemContext(()=> {
            IntPtr provider=IntPtr.Zero,key=IntPtr.Zero;
            try {
                if(NCryptOpenStorageProvider(out provider,"Microsoft Software Key Storage Provider",0)!=0 || NCryptOpenKey(provider,out key,"Google Chromekey1",0,0)!=0) throw new Exception();
                int size; if(NCryptDecrypt(key,encrypted,encrypted.Length,IntPtr.Zero,null,0,out size,0x40)!=0 || size!=32) throw new Exception();
                byte[] plain=new byte[size];
                if(NCryptDecrypt(key,encrypted,encrypted.Length,IntPtr.Zero,plain,size,out size,0x40)!=0) { Clear(plain); throw new Exception(); }
                return plain;
            } finally { if(key!=IntPtr.Zero)NCryptFreeObject(key); if(provider!=IntPtr.Zero)NCryptFreeObject(provider); }
        });
    }
    static void NoLinks(string path) {
        for(string current=Path.GetFullPath(path); !String.IsNullOrEmpty(current); current=Path.GetDirectoryName(current)) {
            if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new Exception();
        }
    }
    static string Source(string supplied) {
        string root=Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Google","Chrome","User Data"));
#if PERRY_IMPORT_FIXTURE
        string fixture=Path.GetFullPath(supplied);
        string temp=Path.GetFullPath(Path.GetTempPath());
        if(fixture.StartsWith(temp,StringComparison.OrdinalIgnoreCase) && Path.GetFileName(fixture).StartsWith("PerryBrowserImport-fixture-")) root=fixture;
#endif
        if(!String.Equals(root,Path.GetFullPath(supplied),StringComparison.OrdinalIgnoreCase)) throw new Exception();
        string file=Path.Combine(root,"Local State"); NoLinks(file); return file;
    }
    static Dictionary<string,object> Keys(string root, string targetKey, bool needsBound) {
        byte[] legacy=null,bound=null,intermediate=null,plain=null,cng=null,target=null;
        try {
            var crypt=root=="-" ? new Dictionary<string,object>() : (Dictionary<string,object>)Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Source(root)))["os_crypt"];
            if(root=="-" && needsBound) throw new Exception();
            var result=new Dictionary<string,object>();
            if(crypt.ContainsKey("encrypted_key")) {
                byte[] stored=Convert.FromBase64String((string)crypt["encrypted_key"]);
                try { if(Encoding.ASCII.GetString(Slice(stored,0,5))!="DPAPI") throw new Exception(); legacy=Unprotect(Slice(stored,5,stored.Length-5)); }
                finally { Clear(stored); }
                if(legacy.Length!=32) throw new Exception(); result["legacy"]=Convert.ToBase64String(legacy);
            }
            byte[] targetStored=Convert.FromBase64String(targetKey);
            try { if(Encoding.ASCII.GetString(Slice(targetStored,0,5))!="DPAPI") throw new Exception(); target=Unprotect(Slice(targetStored,5,targetStored.Length-5)); }
            finally { Clear(targetStored); }
            if(target.Length!=32) throw new Exception(); result["target"]=Convert.ToBase64String(target);
            // Only request App-Bound access when the selected records actually need it.
            if(needsBound) {
                bound=Convert.FromBase64String((string)crypt["app_bound_encrypted_key"]);
                if(Encoding.ASCII.GetString(Slice(bound,0,4))!="APPB") throw new Exception();
                byte[] encrypted=Slice(bound,4,bound.Length-4);
                try { intermediate=SystemContext(()=>Unprotect(encrypted)); } finally { Clear(encrypted); }
                plain=Unprotect(intermediate);
                int headerSize=BitConverter.ToInt32(Slice(plain,0,4),0);
                int offset=checked(4+headerSize);
                int contentSize=BitConverter.ToInt32(Slice(plain,offset,4),0);
                if(contentSize!=61 && contentSize!=93 || checked(offset+4+contentSize)!=plain.Length) throw new Exception();
                byte[] payload=Slice(plain,offset+4,contentSize);
                if(payload[0]==3 && contentSize==93) {
                    cng=Cng(Slice(payload,1,32)); result["cng"]=Convert.ToBase64String(cng);
                } else if((payload[0]!=1 && payload[0]!=2) || contentSize!=61) throw new Exception();
                result["bound"]=Convert.ToBase64String(payload); Clear(payload);
            }
            return result;
        } finally { Clear(legacy);Clear(bound);Clear(intermediate);Clear(plain);Clear(cng);Clear(target); }
    }
    static int Main(string[] args) {
#if PERRY_IMPORT_FIXTURE
        if(args.Length==3 && args[0]=="--fixture-wrap") {
            try {
                string file=Source(args[1]);
                byte[] payload=Convert.FromBase64String(args[2]);
                if(payload.Length==93 && payload[0]==3) {
                    byte[] fake=Slice(payload,1,32),encrypted=FixtureCngWrap(fake);
                    Buffer.BlockCopy(encrypted,0,payload,1,32);Clear(fake);Clear(encrypted);
                } else if(payload.Length!=61 || (payload[0]!=1 && payload[0]!=2)) return 1;
                byte[] header=Encoding.ASCII.GetBytes("Perry disposable fixture");
                byte[] inner;
                using(var stream=new MemoryStream()) using(var writer=new BinaryWriter(stream)) {
                    writer.Write(header.Length);writer.Write(header);writer.Write(payload.Length);writer.Write(payload);writer.Flush();inner=stream.ToArray();
                }
                byte[] user=ProtectedData.Protect(inner,null,DataProtectionScope.CurrentUser);
                byte[] system=SystemContext(()=>ProtectedData.Protect(user,null,DataProtectionScope.CurrentUser));
                byte[] wrapped=new byte[system.Length+4];Buffer.BlockCopy(Encoding.ASCII.GetBytes("APPB"),0,wrapped,0,4);Buffer.BlockCopy(system,0,wrapped,4,system.Length);
                var data=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
                ((Dictionary<string,object>)data["os_crypt"])["app_bound_encrypted_key"]=Convert.ToBase64String(wrapped);
                File.WriteAllText(file,Json.Serialize(data));
                Clear(payload);Clear(inner);Clear(user);Clear(system);Clear(wrapped);return 0;
            } catch (Exception error) {
                File.WriteAllText(Path.Combine(Path.GetTempPath(),"PerryBrowserImportFixture-status.txt"),"wrap:"+error.GetType().Name+":"+error.HResult.ToString("X"));return 1;
            }
        }
        string phase="arguments";
#endif
        if(args.Length!=4 || !args[0].StartsWith("perry-browser-import-")) return 1;
        string pipeName=args[0],nonce=args[1],root=args[2]; uint expectedPid;
        if(!UInt32.TryParse(args[3],out expectedPid) || nonce.Length!=64) return 1;
        try {
#if PERRY_IMPORT_FIXTURE
            phase="pipe";
#endif
            SecurityIdentifier owner=WindowsIdentity.GetCurrent().User;
            PipeSecurity security=new PipeSecurity(); security.SetAccessRuleProtection(true,false);
            security.AddAccessRule(new PipeAccessRule(owner,PipeAccessRights.FullControl,AccessControlType.Allow));
            using(var pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,131072,131072,security)) {
                var connection=pipe.BeginWaitForConnection(null,null);
                if(!connection.AsyncWaitHandle.WaitOne(120000)) return 1;
                pipe.EndWaitForConnection(connection);
#if PERRY_IMPORT_FIXTURE
                phase="client";
#endif
                uint clientPid; if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out clientPid) || clientPid!=expectedPid) return 1;
                IntPtr clientToken=IntPtr.Zero;
                try {
                    using(Process client=Process.GetProcessById((int)clientPid)) {
                        if(!OpenProcessToken(client.Handle,0xA,out clientToken)) return 1;
                        using(WindowsIdentity clientIdentity=new WindowsIdentity(clientToken)) if(!clientIdentity.User.Equals(owner)) return 1;
                    }
                } finally { if(clientToken!=IntPtr.Zero) CloseHandle(clientToken); }
                using(var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true))
                using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true) { AutoFlush=true }) {
#if PERRY_IMPORT_FIXTURE
                    phase="request";
#endif
                    string line=reader.ReadLine(); if(line==null || line.Length>65536) return 1;
                    var request=Json.Deserialize<Dictionary<string,object>>(line);
                    if((string)request["nonce"]!=nonce) return 1;
                    try { writer.WriteLine(Json.Serialize(Keys(root,(string)request["targetKey"],(bool)request["bound"]))); }
                    catch (Exception error) {
#if PERRY_IMPORT_FIXTURE
                        File.WriteAllText(Path.Combine(Path.GetTempPath(),"PerryBrowserImportFixture-status.txt"),"keys:"+error.GetType().Name+":"+error.HResult.ToString("X"));
#endif
                        writer.WriteLine("{\"error\":\"Native credential migration failed. No data was imported.\"}"); return 1;
                    }
                }
            }
            return 0;
        } catch (Exception error) {
#if PERRY_IMPORT_FIXTURE
            File.WriteAllText(Path.Combine(Path.GetTempPath(),"PerryBrowserImportFixture-status.txt"),phase+":"+error.GetType().Name+":"+error.HResult.ToString("X"));
#endif
            return 1;
        }
    }
}
