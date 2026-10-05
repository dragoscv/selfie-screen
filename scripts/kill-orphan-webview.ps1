param([switch]$Kill)
# Lists (and with -Kill stops) WebView2 processes of TikSee whose tiksee.exe
# parent is gone. An orphaned WebView2 keeps the capture card open, so the next
# studio launch fails with "NotReadableError: Device in use".
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
$alive = @(Get-Process tiksee -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$roots = $all | Where-Object { $_.CommandLine -match 'ro\.codai\.tiksee' -and $_.CommandLine -notmatch '--type=' }
foreach ($r in $roots) {
    $orphan = $alive -notcontains [int]$r.ParentProcessId
    '{0} parent={1} orphan={2}' -f $r.ProcessId, $r.ParentProcessId, $orphan
    if ($orphan -and $Kill) {
        # Children die with the browser process.
        Stop-Process -Id $r.ProcessId -Force
        "killed $($r.ProcessId)"
    }
}
