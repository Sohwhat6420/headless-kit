"""Poll every 50 ms for VISIBLE top-level windows that did not exist at start; print each new one (class, pid, title).

Usage: python windowwatch.py <seconds> [--stop-file PATH]
Exit 0 always; the last line is "new visible windows: N".
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

u = ctypes.WinDLL("user32", use_last_error=True)
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def snapshot():
    found = {}

    def cb(h, _):
        if u.IsWindowVisible(h):
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(h, cls, 256)
            t = ctypes.create_unicode_buffer(256)
            u.GetWindowTextW(h, t, 256)
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(pid))
            found[h] = (cls.value, pid.value, t.value)
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return found


secs = float(sys.argv[1])
stop = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--stop-file" else None
base = set(snapshot())
print("READY baseline=%d" % len(base), flush=True)  # the test waits for this before acting
seen = {}
t0 = time.monotonic()
while time.monotonic() - t0 < secs and not (stop and os.path.exists(stop)):
    for h, v in snapshot().items():
        if h not in base and h not in seen:
            seen[h] = v
            print("NEW +%.1fs %s pid=%s %r" % (time.monotonic() - t0, *v), flush=True)
    time.sleep(0.05)
print("new visible windows: %d" % len(seen), flush=True)
