# Run on an ephemeral Windows runner with a fresh user profile.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this synthetic archive test in a fresh GitHub-hosted Windows runner.'
}
$setup = @(Get-ChildItem "$env:CARGO_TARGET_DIR\release\bundle\nsis" -Filter '*-setup.exe')
if ($setup.Count -ne 1) { throw 'Expected exactly one NSIS installer.' }
$installDir = Join-Path $env:RUNNER_TEMP 'LoFoldInstalled'
$archive = Join-Path $env:LOCALAPPDATA 'org.lofold.client\archive.sqlite3'
if ((Test-Path $installDir) -or (Test-Path $archive)) { throw 'An existing installation or archive is present.' }
$installer = Start-Process -FilePath $setup[0].FullName -ArgumentList '/S',"/D=$installDir" -PassThru -Wait
if ($installer.ExitCode) { throw "Installer exited with $($installer.ExitCode)." }
$exe = @(Get-ChildItem $installDir -Filter '*.exe' | Where-Object Name -NotMatch '^uninstall')
if ($exe.Count -ne 1) { throw 'Installed application executable missing.' }
# NSIS itself is a 32-bit bootstrapper; verify the installed application payload.
$appBytes = [System.IO.File]::ReadAllBytes($exe[0].FullName)
$pe = [BitConverter]::ToInt32($appBytes, 0x3c)
if ([BitConverter]::ToUInt32($appBytes, $pe) -ne 0x4550 -or [BitConverter]::ToUInt16($appBytes, $pe + 4) -ne 0x8664) {
  throw 'Installed LoFold executable does not target AMD64.'
}
$version = (Get-Content -Raw apps/desktop/src-tauri/tauri.conf.json | ConvertFrom-Json).version
if ($exe[0].VersionInfo.FileVersionRaw.ToString(3) -ne $version) {
  throw "Installed executable version differs from $version."
}
Write-Output "Verified installed LoFold $version AMD64 executable."
foreach ($resource in 'LICENSE', 'NOTICE') {
  if (!(Test-Path (Join-Path $installDir $resource))) { throw "Missing installed resource $resource." }
}
try {
  # Only the process started by this test receives the loopback WebView2 automation port.
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223'
  foreach ($phase in 'import', 'restart') {
    $app = Start-Process $exe[0].FullName -PassThru
    try {
      node ./scripts/windows/verify-webview.mjs $phase
      if ($LASTEXITCODE) { throw "Installed WebView2 $phase test failed." }
    } finally {
      if (!$app.HasExited) {
        if (!$app.CloseMainWindow() -or !$app.WaitForExit(10000)) { Stop-Process -Id $app.Id -Force }
        $app.WaitForExit()
      }
    }
  }
  $bytes = [System.IO.File]::ReadAllBytes($archive)
  if ($bytes.Length -lt 512 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 15) -eq 'SQLite format 3') {
    throw 'Expected a populated encrypted SQLite database.'
  }
  Get-FileHash $setup[0].FullName -Algorithm SHA256 | Format-List
} finally {
  Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  $uninstall = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstall) {
    $removed = Start-Process $uninstall -ArgumentList '/S' -PassThru -Wait
    if ($removed.ExitCode) { throw "Uninstaller exited with $($removed.ExitCode)." }
  }
}
