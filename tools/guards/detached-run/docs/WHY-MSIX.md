# Why a process started from an MSIX app is not really "installed"

Written up from an investigation on 26 Oct 2026. The machine was a Windows 11 PC; the host app was a desktop app shipped as an MSIX package (the Claude desktop app), whose coding sessions can start child processes. The finding applies to any MSIX-packaged host that launches children.

## Short version

Every process started from inside the packaged app runs under that package's context. Windows **redirects its writes** to `%LOCALAPPDATA%`, `%APPDATA%` and `HKCU` into the package's private store, `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\{Local,Roaming}` and a private registry hive. So an app "installed" by a child of the host, with a Run key for autostart, lived only in that store. Windows never saw the Run key, and the app was ended whenever the package was serviced.

## Evidence

1. **A crash report showed the virtual path.** A Windows Error Reporting `AppHang` report for the installed app recorded its path as `...\Packages\<PackageFamilyName>\LocalCache\Local\<App>\...`, not `%LOCALAPPDATA%\<App>`.
2. **The timing matched package servicing.** The app disappeared at the times the host package was updated. Servicing freezes and then terminates every process in the package, including children that inherited its context.
3. **The real view was empty.** A probe run through `detached-run` (parented to `WmiPrvSE`, so outside the package) found no `%APPDATA%\<app>` folder, no `%LOCALAPPDATA%\<app>` folder and no Run key. Everything the app had written was in the package store.
4. **A control run.** A child of the host that wrote a marker file to `%APPDATA%` had it land in `Packages\...\LocalCache\Roaming` (redirected). A process started through `detached-run` wrote to the real `%APPDATA%`. Its ancestry was `powershell <- node <- WmiPrvSE <- svchost`, with no host process in it.

## A trap: `GetPackageFullName` is not the test

Children of a packaged app inherit the redirection but report **no package identity** (`APPMODEL_ERROR_NO_PACKAGE`, 15700). A child of the host reports "none" exactly like a genuinely unpackaged process. The reliable test is where a marker file physically lands.

## Why a watchdog inside the process cannot help

The app's own hang-watcher was frozen along with the rest of the process when the package was serviced, so it could not restart anything. The remedy has to live outside the process and outside the package.

## What follows

- Start anything that must outlive the host through `detached-run` (or any other launcher that is not a descendant of the host).
- Install anything that must persist (a Run key, a startup app, a config file) from a process that is **not** a descendant of the packaged host, and check by where a marker file lands.
- Do not trust a "success" from an installer run as a child of a packaged app until you have looked at the real, unredirected `%APPDATA%`.

Caveats: this is one machine and one host app; Microsoft's documentation describes package file-system and registry virtualisation, and the inheritance by children is what I measured, not something I found documented.
