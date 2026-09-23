# Build the Kunstmuseum Windows installer (electron-builder / NSIS) and,
# optionally, install it silently on this machine.
#
#   ./release.ps1                 # verify (npm test + npm run smoke), build, print the installer path
#   ./release.ps1 -Install        # ...and install it silently into -InstallDir
#   ./release.ps1 -SkipVerify     # build WITHOUT running the tests/smoke (loud warning; avoid)
#   ./release.ps1 -Install -InstallDir "E:\Apps\kunstmuseum"
#
# Verification is not optional by default: the smoke run launches the real app
# against scratch fixtures and a scratch userData, and it is the only thing that
# proves the renderer (ES modules, cytoscape, the kmimg:// protocol) still works.
# It needs an interactive desktop session (it opens a window and goes fullscreen
# briefly for the screen-mode checks).
#
# THE APP MUST BE CLOSED BEFORE INSTALLING. This script refuses to install while
# a Kunstmuseum.exe from the install folder is running and never kills it: tag
# and layout saves are debounced, so force-killing the app can lose the most
# recent edits. Dev instances (`npm start`) run node_modules\electron\...\electron.exe
# and do not lock the install folder, so they may stay open.
#
# Windows Defender may quarantine the unsigned Kunstmuseum.exe (a false positive
# for an unsigned, never-before-seen binary). If the exe is missing after the
# install, add an exclusion for the install folder yourself in an ELEVATED shell:
#
#   Add-MpPreference -ExclusionPath "D:\Program Files\my_original_app\kunstmuseum"
#
# YOUR DATA IS NEVER TOUCHED by installing, updating or uninstalling: the
# installer only writes to the install folder and the shortcuts, while tags,
# registered folders, layout and settings live in %APPDATA%\Kunstmuseum\
# (library.json) - the same folder `npm start` uses, so a dev setup and the
# installed app share one library. The uninstaller keeps that folder too
# (deleteAppDataOnUninstall: false). Your images are never written by any of this.

param(
    [switch]$Install,
    [switch]$SkipVerify,
    # Passed to NSIS as /D so the install location is deterministic.
    [string]$InstallDir = "D:\Program Files\my_original_app\kunstmuseum"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Push-Location $root
try {
    # ---------------------------------------------------------------- verify
    if ($SkipVerify) {
        Write-Host ""
        Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Red
        Write-Host "!!  -SkipVerify: npm test and npm run smoke were NOT run.              !!" -ForegroundColor Red
        Write-Host "!!  This installer is UNVERIFIED - say so when you report the release. !!" -ForegroundColor Red
        Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Red
        Write-Host ""
    }
    else {
        Write-Host "== 1/3  verify: npm test ==" -ForegroundColor Cyan
        npm test
        if ($LASTEXITCODE -ne 0) { throw "npm test failed (exit $LASTEXITCODE) - not building." }

        Write-Host "`n== 1/3  verify: npm run smoke ==" -ForegroundColor Cyan
        npm run smoke
        if ($LASTEXITCODE -ne 0) { throw "npm run smoke failed (exit $LASTEXITCODE) - not building." }
    }

    # ----------------------------------------------------------------- build
    Write-Host "`n== 2/3  build: electron-builder --win nsis ==" -ForegroundColor Cyan
    npx electron-builder --win nsis
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder failed (exit $LASTEXITCODE). If it could not overwrite dist\, close any running installer or dist\win-unpacked\Kunstmuseum.exe and retry."
    }

    # ---------------------------------------------------------- locate setup
    $setup = Get-ChildItem "$root\dist\Kunstmuseum-Setup-*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike "*__uninstaller*" } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $setup) { throw "no dist\Kunstmuseum-Setup-*.exe was produced." }
    Write-Host "`n== 3/3  installer ==" -ForegroundColor Cyan
    Write-Host ("installer: {0}  ({1:N1} MB, {2})" -f $setup.FullName, ($setup.Length / 1MB), $setup.LastWriteTime) -ForegroundColor Green

    if ($Install) {
        # ------------------------------------------------ refuse while running
        $running = Get-Process -Name "Kunstmuseum" -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
        if ($running) {
            Write-Host "`nKunstmuseum is running from $InstallDir (PID $($running.Id -join ', '))." -ForegroundColor Red
            Write-Host "Close the app (its tags/layout saves are debounced - do NOT kill it), then re-run:" -ForegroundColor Yellow
            Write-Host "   pwsh ./release.ps1 -Install -SkipVerify   # the build above is already verified" -ForegroundColor Gray
            exit 2
        }

        # --------------------------------------------------------- install
        Write-Host "`ninstalling to $InstallDir (your data in %APPDATA%\Kunstmuseum is left alone)..." -ForegroundColor Cyan
        # /S = silent. /D = target dir; NSIS requires it LAST and UNQUOTED, even with spaces.
        Start-Process $setup.FullName -ArgumentList "/S /D=$InstallDir" -Wait
        Start-Sleep -Seconds 3

        # ---------------------------------------------------------- verify
        $exe = Join-Path $InstallDir "Kunstmuseum.exe"
        if (-not (Test-Path $exe)) {
            Write-Host "`nKunstmuseum.exe is NOT in $InstallDir." -ForegroundColor Red
            Write-Host "Either the installer went elsewhere (check /D= is last and unquoted), or Windows Defender" -ForegroundColor Red
            Write-Host "quarantined the unsigned binary (false positive). Add the exclusion yourself in an ELEVATED shell," -ForegroundColor Yellow
            Write-Host "then re-run the installer:" -ForegroundColor Yellow
            Write-Host "   Add-MpPreference -ExclusionPath `"$InstallDir`"" -ForegroundColor Gray
            Write-Host "   Start-Process '$($setup.FullName)' -ArgumentList '/S /D=$InstallDir' -Wait" -ForegroundColor Gray
            exit 1
        }
        $i = Get-Item $exe
        Write-Host ("OK  {0}  {1}  {2:N0} bytes" -f $i.FullName, $i.LastWriteTime, $i.Length) -ForegroundColor Green

        # The exe must be the one just built (NSIS silently skips files it cannot overwrite).
        $built = Get-Item "$root\dist\win-unpacked\Kunstmuseum.exe" -ErrorAction SilentlyContinue
        $asarBuilt = Get-Item "$root\dist\win-unpacked\resources\app.asar" -ErrorAction SilentlyContinue
        $asarInst = Get-Item (Join-Path $InstallDir "resources\app.asar") -ErrorAction SilentlyContinue
        $stale = $false
        if ($built -and $built.Length -ne $i.Length) { $stale = $true }
        if ($asarBuilt -and (-not $asarInst -or $asarBuilt.Length -ne $asarInst.Length)) { $stale = $true }
        if ($stale) {
            Write-Host "STALE INSTALL: the installed files do not match the build in dist\win-unpacked." -ForegroundColor Red
            Write-Host "Close the app completely and re-run the installer." -ForegroundColor Yellow
            exit 1
        }
        Write-Host ("OK  resources\app.asar  {0:N0} bytes (matches the build)" -f $asarInst.Length) -ForegroundColor Green

        $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "Kunstmuseum.lnk"   # may be OneDrive-redirected
        $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "Kunstmuseum.lnk"
        foreach ($lnk in @($desktop, $startMenu)) {
            if (Test-Path $lnk) { Write-Host "OK  shortcut  $lnk" -ForegroundColor Green }
            else { Write-Host "MISSING shortcut  $lnk" -ForegroundColor Yellow }
        }
        Write-Host "`ndone - start 'Kunstmuseum' from the desktop or the Start menu." -ForegroundColor Green
    }
    else {
        Write-Host "`n--- installing (manual) ---" -ForegroundColor Cyan
        Write-Host "Close Kunstmuseum if it is running, then either double-click the installer above or run:" -ForegroundColor Yellow
        Write-Host "   Start-Process '$($setup.FullName)' -ArgumentList '/S /D=$InstallDir' -Wait" -ForegroundColor Gray
        Write-Host "or simply:  pwsh ./release.ps1 -Install -SkipVerify   (this build is already verified)" -ForegroundColor Gray
        Write-Host "If Defender removes Kunstmuseum.exe (unsigned, false positive), add in an ELEVATED shell:" -ForegroundColor Yellow
        Write-Host "   Add-MpPreference -ExclusionPath `"$InstallDir`"" -ForegroundColor Gray
        Write-Host "`nYour library (tags, folders, layout) in %APPDATA%\Kunstmuseum\ is left untouched." -ForegroundColor Gray
    }
}
finally {
    Pop-Location
}
