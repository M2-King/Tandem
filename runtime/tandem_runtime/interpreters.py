"""Which Python runs the project's code.

Order of preference:
1. The interpreter saved in <project>/.tandem/settings.json ("python").
2. The project's own virtual environment (.venv, venv or env).
3. The interpreter given on the command line (--python).
4. python3 on PATH (on Windows: the `py` launcher's default Python 3, then
   python.exe on PATH, skipping the Microsoft Store placeholder; on macOS:
   the first Python 3.11+ on PATH or where Homebrew, python.org and pyenv
   install it, since an app opened from the Finder gets only the system
   PATH. Apple's /usr/bin/python3 is too old and may ask to install the
   developer tools, so it is never tried).

The runtime's own interpreter is never used for project code: it holds the
runtime's dependencies, not the project's.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

VENV_DIRS = (".venv", "venv", "env")


def venv_python(env_dir: Path) -> Path | None:
    for candidate in (env_dir / "bin" / "python", env_dir / "Scripts" / "python.exe"):
        if candidate.exists():
            return candidate
    return None


def is_venv(python: Path) -> bool:
    return (python.parent.parent / "pyvenv.cfg").exists()


def settings_path(root: Path) -> Path:
    return root / ".tandem" / "settings.json"


def load_settings(root: Path) -> dict:
    try:
        return json.loads(settings_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(root: Path, settings: dict) -> None:
    path = settings_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def describe(python: str | Path) -> dict:
    """Version and environment details for an interpreter, by asking it."""
    probe = (
        "import json, sys, platform;"
        "print(json.dumps({'version': platform.python_version(), 'executable': sys.executable,"
        " 'prefix': sys.prefix, 'base_prefix': sys.base_prefix,"
        " 'implementation': platform.python_implementation()}))"
    )
    try:
        out = subprocess.run([str(python), "-c", probe], capture_output=True, text=True, timeout=15, check=True)
        info = json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        return {"path": str(python), "ok": False, "error": f"Couldn't start {python}: {exc}"}
    info["path"] = str(python)
    info["ok"] = True
    info["is_venv"] = info["prefix"] != info["base_prefix"]
    return info


def resolve_interpreter(root: Path, cli_python: str | None = None) -> tuple[Path | None, str]:
    """(interpreter, where it came from). Interpreter is None if nothing usable was found."""
    saved = load_settings(root).get("python")
    if saved and Path(saved).exists():
        return Path(saved), "project setting"
    for name in VENV_DIRS:
        py = venv_python(root / name)
        if py:
            return py, f"project environment ({name})"
    if cli_python and Path(cli_python).exists():
        return Path(cli_python), "command line"
    if sys.platform == "win32":
        found = _windows_python()
    elif sys.platform == "darwin":
        found = _mac_python()
    else:
        found = shutil.which("python3") or shutil.which("python")
    if found and Path(found).resolve() != Path(sys.executable).resolve():
        return Path(found), "PATH"
    return None, "none"


_WIN_CACHE: list = []


def _windows_python() -> str | None:
    """A real Python 3 on Windows: the py launcher's default, else python.exe on PATH."""
    if _WIN_CACHE:
        return _WIN_CACHE[0]
    found = None
    launcher = shutil.which("py")
    if launcher:
        try:
            out = subprocess.run([launcher, "-3", "-c", "import sys; print(sys.executable)"],
                                 capture_output=True, text=True, timeout=15)
            exe = out.stdout.strip().splitlines()[-1] if out.returncode == 0 and out.stdout.strip() else ""
            if exe and Path(exe).exists():
                found = exe
        except (OSError, subprocess.SubprocessError):
            pass
    if found is None:
        for name in ("python", "python3"):
            exe = shutil.which(name)
            # %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe only opens the Store.
            if exe and "windowsapps" not in exe.lower():
                found = exe
                break
    if found:
        _WIN_CACHE.append(found)
    return found


# macOS: where Python is usually installed, beyond the PATH an app opened
# from the Finder gets (/usr/bin:/bin:/usr/sbin:/sbin).
MAC_PLACES = (
    "/opt/homebrew/bin",  # Homebrew, Apple silicon
    "/usr/local/bin",  # Homebrew (Intel) and python.org links
    "/Library/Frameworks/Python.framework/Versions/Current/bin",  # python.org
    "~/.pyenv/shims",
    "~/.local/bin",
)
MAC_NAMES = ("python3", "python3.14", "python3.13", "python3.12", "python3.11")
_MAC_CACHE: list = []


def _python_version(exe: Path) -> tuple[int, int] | None:
    try:
        out = subprocess.run([str(exe), "-c", "import sys; print('%d %d' % sys.version_info[:2])"],
                             capture_output=True, text=True, timeout=10)
        major, minor = out.stdout.strip().splitlines()[-1].split()
        return int(major), int(minor)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def mac_candidates(path_env: str | None = None, places: tuple[str, ...] = MAC_PLACES) -> list[Path]:
    """Pythons to try on macOS, in order: PATH first, then the usual places."""
    dirs = [d for d in (os.environ.get("PATH", "") if path_env is None else path_env).split(os.pathsep) if d]
    dirs += [os.path.expanduser(d) for d in places]
    framework = Path("/Library/Frameworks/Python.framework/Versions")
    if framework.is_dir():
        dirs += [str(v / "bin") for v in sorted(framework.iterdir(), reverse=True) if v.name[:1].isdigit()]
    seen: set[str] = set()
    found: list[Path] = []
    for d in dirs:
        if d.rstrip("/") == "/usr/bin":  # Apple's: old, and may ask to install the developer tools
            continue
        for name in MAC_NAMES:
            exe = Path(d) / name
            key = str(exe)
            if key not in seen and exe.is_file() and os.access(exe, os.X_OK):
                seen.add(key)
                found.append(exe)
    return found


def _mac_python(path_env: str | None = None, places: tuple[str, ...] = MAC_PLACES) -> str | None:
    """The first Python 3.11 or newer on macOS (else the first Python 3 found)."""
    if _MAC_CACHE and path_env is None and places == MAC_PLACES:
        return _MAC_CACHE[0]
    first = None
    for exe in mac_candidates(path_env, places):
        version = _python_version(exe)
        if not version or version[0] != 3:
            continue
        first = first or str(exe)
        if version >= (3, 11):
            first = str(exe)
            break
    if first and path_env is None and places == MAC_PLACES:
        _MAC_CACHE.append(first)
    return first


def child_env(python: Path, extra: dict[str, str]) -> dict[str, str]:
    """Environment for a child process: the user's environment, minus runtime
    secrets, with the virtual environment activated when there is one."""
    # Only the runtime's own variables are removed. Variables the user set in
    # their shell stay: their programs may rely on them.
    env = {k: v for k, v in os.environ.items() if not k.startswith("TANDEM_")}
    env.pop("PYTHONHOME", None)
    if sys.platform == "darwin":
        # An app opened from the Finder has only the system PATH: add the
        # usual places, so the project's code finds pip, Homebrew tools etc.
        have = env.get("PATH", "").split(os.pathsep)
        extra_dirs = [str(python.parent)] + [os.path.expanduser(d) for d in MAC_PLACES]
        env["PATH"] = os.pathsep.join([d for d in extra_dirs if d not in have] + [d for d in have if d])
    if is_venv(python):
        env["VIRTUAL_ENV"] = str(python.parent.parent)
        env["PATH"] = str(python.parent) + os.pathsep + env.get("PATH", "")
    env.update(extra)
    return env
