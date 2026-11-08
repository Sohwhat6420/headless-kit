// Shows why detached-run uses ShowWindow=0 and not CREATE_NO_WINDOW: WMI Win32_Process.Create accepts the first and
// returns 21 (Invalid parameter) for the second. Runs a no-op `cmd /c exit 0` with every window hidden.
//   node examples/wmi-createflags-probe.mjs
import { spawnSync } from 'node:child_process';
const run = (flags) => {
  const script = [
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0${flags === null ? '' : '; CreateFlags = [uint32]' + flags} }`,
    `try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c exit 0'; ProcessStartupInformation = $si }; "ReturnValue=$($r.ReturnValue)" } catch { "EXCEPTION " + $_.Exception.Message }`,
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return (r.stdout || r.stderr).trim();
};
console.log('ShowWindow=0, no CreateFlags (what detached-run does):', run(null));
console.log('CreateFlags=0x08000000 (CREATE_NO_WINDOW):', run('0x08000000'));
