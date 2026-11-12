"""Environments and packages for a project.

* Interpreters: the Python installations on this computer (python3.x on PATH,
  /usr/bin, /usr/local/bin, Homebrew, pyenv, uv; on Windows the `py` launcher's
  list and the usual install folders).
* Project environments: virtual environments inside the project folder.
* Selection: saved in <project>/.tandem/settings.json ("python"); runs use it.
* Packages: `pip list` for the selected environment, and imports in the
  project's code that the environment can't satisfy.

Nothing here installs anything. Creating an environment and installing
packages are separate, explicit steps (jobs.py), started only when the person
confirms the exact command.
"""

from __future__ import annotations

import ast
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .files import SKIP_DIRS
from .interpreters import describe, is_venv, load_settings, save_settings, venv_python

# Import name → the package to install, where they differ.
IMPORT_TO_PACKAGE = {
    "sklearn": "scikit-learn",
    "skimage": "scikit-image",
    "cv2": "opencv-python",
    "PIL": "pillow",
    "yaml": "pyyaml",
    "bs4": "beautifulsoup4",
    "dateutil": "python-dateutil",
    "dotenv": "python-dotenv",
    "Crypto": "pycryptodome",
    "serial": "pyserial",
    "attr": "attrs",
    "jwt": "PyJWT",
    "OpenGL": "PyOpenGL",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "magic": "python-magic",
    "usb": "pyusb",
    "wx": "wxPython",
    "gi": "PyGObject",
    "fitz": "PyMuPDF",
    "mpl_toolkits": "matplotlib",
    "Levenshtein": "python-Levenshtein",
    "sentencepiece": "sentencepiece",
    "google.protobuf": "protobuf",
    "jose": "python-jose",
    "multipart": "python-multipart",
    "socks": "PySocks",
    "win32api": "pywin32",
    "win32con": "pywin32",
    "pythoncom": "pywin32",
}

# What a package name may look like when it is installed: a name, optional
# extras and an optional version constraint. Nothing starting with "-", so a
# request can never smuggle pip options (another index, a local path, …).
PACKAGE_SPEC = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?"
    r"(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?"
    r"(?:\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]{1,40}"
    r"(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]{1,40})*)?$"
)

PROBE_TIMEOUT = 20


class EnvError(Exception):
    """A readable reason an environment action can't be done."""


def _quiet() -> dict:
    """No console window for helper processes on Windows."""
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


# ---------------------------------------------------------------- discovery

def _candidate_paths() -> list[str]:
    found: list[str] = []
    if sys.platform == "win32":
        launcher = shutil.which("py")
        if launcher:
            try:
                out = subprocess.run([launcher, "-0p"], capture_output=True, text=True, timeout=PROBE_TIMEOUT, **_quiet())
                for line in out.stdout.splitlines():
                    match = re.search(r"([A-Za-z]:\\.*python(?:w)?\.exe)\s*$", line.strip(), re.IGNORECASE)
                    if match:
                        found.append(match.group(1))
            except (OSError, subprocess.SubprocessError):
                pass
        for name in ("python", "python3"):
            exe = shutil.which(name)
            if exe and "windowsapps" not in exe.lower():
                found.append(exe)
        for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                found += glob.glob(os.path.join(base, "Programs", "Python", "Python3*", "python.exe"))
                found += glob.glob(os.path.join(base, "Python3*", "python.exe"))
        return found
    names = ["python3"] + [f"python3.{minor}" for minor in range(8, 16)]
    for name in names:
        exe = shutil.which(name)
        if exe:
            found.append(exe)
    for folder in ("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"):
        for name in names:
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                found.append(path)
    home = Path.home()
    found += glob.glob(str(home / ".pyenv" / "versions" / "*" / "bin" / "python3"))
    found += glob.glob(str(home / ".local" / "share" / "uv" / "python" / "*" / "bin" / "python3"))
    found += glob.glob("/Library/Frameworks/Python.framework/Versions/3.*/bin/python3")
    return found


_CACHE: dict = {"at": 0.0, "items": []}


def interpreters(refresh: bool = False) -> list[dict]:
    """Python installations on this computer (not virtual environments), newest first."""
    if not refresh and _CACHE["items"] and time.monotonic() - _CACHE["at"] < 120:
        return _CACHE["items"]
    seen: dict[str, str] = {}
    for raw in _candidate_paths():
        try:
            real = os.path.realpath(raw)
        except OSError:
            continue
        if real not in seen and os.path.isfile(raw):
            seen[real] = raw
    candidates = list(seen.values())
    with ThreadPoolExecutor(max_workers=8) as pool:
        infos = list(pool.map(describe, candidates))
    items: list[dict] = []
    seen_exec: set[str] = set()
    for info in infos:
        if not info.get("ok") or info.get("is_venv"):
            continue
        key = os.path.realpath(info.get("executable") or info["path"])
        if key in seen_exec:
            continue
        seen_exec.add(key)
        items.append({"path": info["path"], "version": info["version"], "implementation": info.get("implementation")})
    items.sort(key=lambda i: tuple(int(x) for x in re.findall(r"\d+", i["version"])[:3]), reverse=True)
    _CACHE.update(at=time.monotonic(), items=items)
    return items


# What shared projects get by default ("Preparing Python" in the app): the
# usual data science packages, and the kernel for notebooks.
SHARED_PACKAGES = ("numpy", "pandas", "matplotlib", "ipykernel")


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", version or "")[:2])


def preferred_base(found: list[dict]) -> dict | None:
    """The Python to make an environment from: 3.12, then 3.13, 3.11, 3.10 (the
    newest versions may not have ready-made packages yet), else the newest 3.9+."""
    usable = [i for i in found if _version_tuple(i.get("version", "")) >= (3, 9)]
    for wanted in ((3, 12), (3, 13), (3, 11), (3, 10)):
        for item in usable:
            if _version_tuple(item["version"]) == wanted:
                return item
    return usable[0] if usable else None


def project_envs(root: Path) -> list[dict]:
    """Virtual environments directly inside the project folder."""
    out = []
    try:
        entries = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return out
    for folder in entries:
        if not (folder / "pyvenv.cfg").exists():
            continue
        python = venv_python(folder)
        if python is None:
            continue
        version = None
        try:
            cfg = (folder / "pyvenv.cfg").read_text(encoding="utf-8", errors="replace")
            match = re.search(r"^\s*version(?:_info)?\s*=\s*([\d.]+)", cfg, re.MULTILINE)
            version = match.group(1) if match else None
        except OSError:
            pass
        out.append({"name": folder.name, "path": str(python), "version": version})
    return out


def environments(root: Path, current: Path | None, source: str) -> dict:
    """Everything the environment menu shows."""
    saved = load_settings(root).get("python")
    return {
        "current": {**describe(current), "source": source} if current else None,
        "selected": saved,
        "project": project_envs(root),
        "interpreters": interpreters(),
    }


def select(root: Path, python: str | None) -> None:
    """Use this interpreter for the project's runs (None: choose automatically)."""
    settings = load_settings(root)
    if python is None:
        settings.pop("python", None)
    else:
        path = Path(python)
        if not path.is_file():
            raise EnvError(f"{python} doesn't exist.")
        info = describe(path)
        if not info.get("ok"):
            raise EnvError(info.get("error") or f"{python} didn't start.")
        settings["python"] = str(path)
    save_settings(root, settings)


# ---------------------------------------------------------------- creating

ENV_NAME = re.compile(r"^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,40}$")


def create_command(root: Path, base: str, name: str) -> tuple[list[str], Path]:
    """The exact command that creates an environment, and where it goes."""
    if not ENV_NAME.match(name or ""):
        raise EnvError("Use a short folder name: letters, numbers, dots, dashes or underscores (for example .venv).")
    known = {i["path"] for i in interpreters()}
    if base not in known:
        info = describe(base)
        if not info.get("ok") or info.get("is_venv"):
            raise EnvError("Choose one of the Python installations Tandem found.")
    target = root / name
    if target.exists():
        raise EnvError(f"{name} already exists in this project. Choose another name.")
    return [base, "-m", "venv", str(target)], target


def created_python(target: Path) -> Path:
    python = venv_python(target)
    if python is None:
        raise EnvError("The environment was created without a Python interpreter.")
    return python


def explain_create_failure(log: str, base_version: str | None = None) -> str:
    if "ensurepip is not available" in log or "No module named ensurepip" in log:
        minor = ".".join((base_version or "").split(".")[:2])
        pkg = f"python{minor}-venv" if minor else "python3-venv"
        return (f"This Python can't create environments yet: it is missing its venv support. "
                f"On Debian or Ubuntu, install the {pkg} package (sudo apt install {pkg}), then try again.")
    if "No module named venv" in log:
        return "This Python doesn't include the venv module. Choose another Python installation."
    return "Creating the environment failed. The log above shows why."


# ---------------------------------------------------------------- packages

def can_install_into(python: Path) -> tuple[bool, str | None]:
    """Tandem installs only into environments of the project, never the system Python."""
    if is_venv(python):
        return True, None
    prefix = python.parent if sys.platform == "win32" else python.parent.parent
    if (prefix / "conda-meta").is_dir():
        return True, None
    return False, ("This is a system Python installation. Tandem doesn't install packages into it, so other programs "
                   "on this computer aren't affected. Create an environment for this project first.")


def installed_packages(python: Path) -> list[dict]:
    try:
        out = subprocess.run([str(python), "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
                             capture_output=True, text=True, timeout=90, **_quiet())
    except (OSError, subprocess.SubprocessError) as exc:
        raise EnvError(f"Couldn't ask pip for the package list: {exc}") from None
    if out.returncode != 0:
        if "No module named pip" in out.stderr:
            raise EnvError("pip isn't available in this environment.")
        raise EnvError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "pip list failed.")
    try:
        items = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise EnvError("pip returned a package list Tandem couldn't read.") from None
    return sorted(({"name": i["name"], "version": i["version"]} for i in items), key=lambda i: i["name"].lower())


def project_imports(root: Path, limit: int = 400) -> dict[str, list[dict]]:
    """Top-level modules the project's .py files import, with where."""
    found: dict[str, list[dict]] = {}
    local: set[str] = set()
    sources: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
                       and not (Path(dirpath) / d / "pyvenv.cfg").exists()]
        here = Path(dirpath)
        for d in dirnames:
            local.add(d)
        for name in filenames:
            if name.endswith(".py"):
                local.add(name[:-3])
                sources.append(here / name)
        if len(sources) > limit:
            break
    for path in sources[:limit]:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (SyntaxError, ValueError, OSError):
            continue
        rel = path.relative_to(root).as_posix()
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            for full in names:
                top = full.split(".")[0]
                key = "google.protobuf" if full.startswith("google.protobuf") else top
                if top in local:
                    continue
                found.setdefault(key, []).append({"path": rel, "line": node.lineno})
    return found


def missing_imports(root: Path, python: Path) -> list[dict]:
    """Imports in the project the environment can't satisfy, with the package that provides each."""
    wanted = project_imports(root)
    if not wanted:
        return []
    probe = (
        "import importlib.util, json, sys\n"
        "names = json.loads(sys.argv[1])\n"
        "std = set(getattr(sys, 'stdlib_module_names', ())) | set(sys.builtin_module_names)\n"
        "out = {}\n"
        "for n in names:\n"
        "    top = n.split('.')[0]\n"
        "    if top in std: out[n] = True; continue\n"
        "    try: out[n] = importlib.util.find_spec(n) is not None\n"
        "    except Exception: out[n] = False\n"
        "print(json.dumps(out))\n"
    )
    try:
        out = subprocess.run([str(python), "-c", probe, json.dumps(sorted(wanted))], capture_output=True, text=True,
                             timeout=PROBE_TIMEOUT, cwd=str(root), **_quiet())
        available = json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return []
    missing = []
    for module, places in sorted(wanted.items()):
        if available.get(module, True):
            continue
        missing.append({"module": module, "package": IMPORT_TO_PACKAGE.get(module, module), "where": places[:5]})
    return missing


def install_command(python: Path, packages: list[str] | None = None, requirements: Path | None = None) -> list[str]:
    """The exact pip command for an approved install."""
    ok, reason = can_install_into(python)
    if not ok:
        raise EnvError(reason)
    command = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
    if requirements is not None:
        return command + ["-r", str(requirements)]
    specs = [p.strip() for p in (packages or []) if p.strip()]
    if not specs:
        raise EnvError("Choose at least one package.")
    if len(specs) > 30:
        raise EnvError("Install at most 30 packages at a time.")
    bad = [p for p in specs if not PACKAGE_SPEC.match(p)]
    if bad:
        raise EnvError(f"“{bad[0]}” isn't a package name Tandem can install (for example: numpy or pandas>=2).")
    return command + specs


def explain_install_failure(log: str) -> str:
    if "No matching distribution found" in log or "Could not find a version that satisfies" in log:
        return "pip couldn't find that package (or a version for this Python). Check the name and the Python version."
    if "Failed to establish a new connection" in log or "Temporary failure in name resolution" in log \
            or "NewConnectionError" in log:
        return "pip couldn't reach the package index. Check your internet connection."
    if "No space left on device" in log:
        return "The disk is full."
    if "Microsoft Visual C++" in log or "error: command 'gcc' failed" in log or "Failed building wheel" in log:
        return ("The package had to be built from source and the build failed. Try a version with ready-made wheels "
                "for this Python, or a newer Python.")
    return "The install failed. The log above shows why."
