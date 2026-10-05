# TikSee release: build the signed NSIS installer + updater artefact and,
# with -Publish, upload it to gs://tiksee-releases with a fresh latest.json.
#
# Signing key: %USERPROFILE%\.tauri\tiksee.key (never committed).
# Password:    Windows Credential Manager generic credential tauri-signing.ro.codai.tiksee.
# Run from a CLEAN tree via deploy-clean.ps1 when publishing.
param(
    [switch]$Publish,
    [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'apps\desktop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TikseeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null;
    var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    var s = Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    CredFree(p); return s;
  }
}
'@

$keyPath = Join-Path $HOME '.tauri\tiksee.key'
if (-not (Test-Path $keyPath)) { throw "signing key missing: $keyPath" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $keyPath
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [TikseeCred]::Read('tauri-signing.ro.codai.tiksee')
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { throw 'signing password missing in Credential Manager' }

try {
    Set-Location $root
    pnpm turbo run build --filter=@tiksee/core --filter=@tiksee/sidecar
    if ($LASTEXITCODE) { throw "workspace build failed ($LASTEXITCODE)" }
    Set-Location $desktop
    pnpm tauri build
    if ($LASTEXITCODE) { throw "tauri build failed ($LASTEXITCODE)" }
} finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$conf = Get-Content (Join-Path $desktop 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
$bundle = Join-Path $desktop 'src-tauri\target\release\bundle\nsis'
$setup = Get-ChildItem $bundle -Filter "*_${version}_x64-setup.exe" | Select-Object -First 1
if (-not $setup) { throw "installer for $version not found in $bundle" }
$sig = "$($setup.FullName).sig"
if (-not (Test-Path $sig)) { throw 'updater signature missing (createUpdaterArtifacts?)' }
Write-Host ("built {0} ({1:N1} MB)" -f $setup.Name, ($setup.Length / 1MB))

if (-not $Publish) { return }

$bucket = 'gs://tiksee-releases'
$base = 'https://storage.googleapis.com/tiksee-releases'
$remoteName = "TikSee_${version}_x64-setup.exe"
gcloud storage cp $setup.FullName "$bucket/$version/$remoteName"
if ($LASTEXITCODE) { throw 'upload failed' }

$manifest = [ordered]@{
    version   = $version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = (Get-Content -Raw $sig).Trim()
            url       = "$base/$version/$remoteName"
        }
    }
}
$tmp = Join-Path $env:TEMP 'tiksee-latest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $tmp -Encoding utf8NoBOM
gcloud storage cp $tmp "$bucket/latest.json" --cache-control='no-cache, max-age=0'
if ($LASTEXITCODE) { throw 'latest.json upload failed' }
Write-Host "published $version -> $base/latest.json"
