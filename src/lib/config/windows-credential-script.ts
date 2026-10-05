/** Static PowerShell bridge; all request data, including secrets, arrives on stdin. */
export const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ChargebeeCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) {
      int code = Marshal.GetLastWin32Error();
      if (code == 1168) return null;
      throw new Win32Exception(code);
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      try {
        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
  public static void Write(string target, string account, string encoded) {
    byte[] bytes = Convert.FromBase64String(encoded);
    IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      Credential credential = new Credential();
      credential.Type = 1; // CRED_TYPE_GENERIC
      credential.TargetName = target;
      credential.UserName = account;
      credential.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE: same user, subsequent logons
      credential.CredentialBlobSize = (uint)bytes.Length;
      credential.CredentialBlob = pointer;
      if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(pointer, i, 0);
      Marshal.FreeHGlobal(pointer);
      Array.Clear(bytes, 0, bytes.Length);
    }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0)) {
      int code = Marshal.GetLastWin32Error();
      if (code != 1168) throw new Win32Exception(code);
    }
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = 'chargebee-cli/' + $request.account
  switch ($request.operation) {
    'get' {
      $value = [ChargebeeCredentials]::Read($target)
      if ($null -eq $value) { [Console]::Out.Write('null') }
      else { [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $value)) }
    }
    'set' { [ChargebeeCredentials]::Write($target, $request.account, $request.secret) }
    'delete' { [ChargebeeCredentials]::Delete($target) }
    default { throw 'Unknown credential operation' }
  }
} catch {
  # Do not echo the request or exception context, which may contain the secret.
  [Console]::Error.Write('Windows Credential Manager operation failed.')
  exit 1
}
`;
