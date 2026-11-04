"""Process-tree control for runs, per platform.

POSIX: each run is its own session / process group. Stop sends SIGINT, then
SIGTERM, then SIGKILL to the group. The wrapper watches its parent and ends the
group if the runtime dies.

Windows: each run starts in a new console process group and is placed in a Job
Object that kills every process in it when the job closes. Stop sends
CTRL_BREAK (the wrapper turns it into KeyboardInterrupt), then terminates the
job. If the runtime dies, Windows closes the job handle and ends the tree.
"""

from __future__ import annotations

import os
import signal
import sys

IS_WINDOWS = sys.platform == "win32"


class ProcessTree:
    """Handle on a started run's process and everything it starts."""

    def __init__(self, pid: int):
        self.pid = pid
        self._job = None
        if IS_WINDOWS:
            self._job = _win_job_for(pid)

    # Escalation steps: (action, seconds to wait for exit afterwards).
    def steps(self):
        if IS_WINDOWS:
            return ((self._ctrl_break, 1.5), (self._terminate_job, 5))
        return ((lambda: self._killpg(signal.SIGINT), 1.5),
                (lambda: self._killpg(signal.SIGTERM), 1.5),
                (lambda: self._killpg(signal.SIGKILL), 5))

    def close(self) -> None:
        """Release the job (Windows: ends anything the run left behind)."""
        if self._job is not None:
            _kernel32().CloseHandle(self._job)
            self._job = None

    # -- POSIX --
    def _killpg(self, sig) -> bool:
        try:
            os.killpg(self.pid, sig)
            return True
        except ProcessLookupError:
            return False

    # -- Windows --
    def _ctrl_break(self) -> bool:
        try:
            os.kill(self.pid, signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        except OSError:
            pass  # no shared console: the next step terminates the job
        return True

    def _terminate_job(self) -> bool:
        if self._job is not None:
            _kernel32().TerminateJobObject(self._job, 1)
            return True
        try:
            os.kill(self.pid, signal.SIGTERM)  # TerminateProcess
        except OSError:
            return False
        return True


def spawn_options() -> dict:
    """Extra keyword arguments for asyncio.create_subprocess_exec."""
    if IS_WINDOWS:
        import subprocess
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def wrapper_env() -> dict[str, str]:
    """Environment variables the wrapper needs for this platform."""
    return {} if IS_WINDOWS else {"TANDEM_WATCH_PARENT": "1"}


# ---------------------------------------------------------------- Windows job objects

_K32 = None


def _kernel32():
    global _K32
    if _K32 is None:
        import ctypes
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        k.SetInformationJobObject.restype = wintypes.BOOL
        k.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        k.TerminateJobObject.restype = wintypes.BOOL
        k.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        k.CloseHandle.restype = wintypes.BOOL
        k.CloseHandle.argtypes = (wintypes.HANDLE,)
        _K32 = k
    return _K32


def _win_job_for(pid: int):
    """A job that kills the whole tree when closed, with the process in it."""
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMITS(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMITS(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    JobObjectExtendedLimitInformation = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001

    k = _kernel32()
    job = k.CreateJobObjectW(None, None)
    if not job:
        return None
    info = EXTENDED_LIMITS()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
    handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
    if ok and handle:
        ok = k.AssignProcessToJobObject(job, handle)
    if handle:
        k.CloseHandle(handle)
    if not ok:
        k.CloseHandle(job)
        return None
    return job


def pid_alive(pid: int) -> bool:
    """Is the process still running? (A zombie counts as gone.)"""
    if IS_WINDOWS:
        import ctypes

        k = _kernel32()
        handle = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(handle, ctypes.byref(code))
        k.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return True


def exit_with(pid: int, interval: float = 1.0) -> None:
    """End this process when process `pid` (the desktop app) is gone, so the
    runtime never outlives the window that started it."""
    import threading
    import time

    def watch():
        while pid_alive(pid):
            time.sleep(interval)
        os._exit(0)  # runs end too: their jobs (Windows) or parent watch (POSIX)

    threading.Thread(target=watch, name="tandem-app-watch", daemon=True).start()
