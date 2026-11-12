"""Working copies of Tandem Cowork shared projects, on this computer.

A shared project's files live in Supabase and in the app. To run them with
this computer's Python, the app writes them into a folder of their own,

    <shared root>/<project id>/

(the desktop app's user data folder, Shared/), before each run or notebook
kernel start: the current text of every file, edits not yet saved included.
Only files that changed are written; files removed from the project are
deleted. Files a run creates (charts, output CSVs) stay in the working copy,
on this computer: they are never uploaded.

Each working copy has its own runs and kernels, separate from the device
project the runtime was opened with. The Python for shared projects is
chosen once for all of them (<shared root>/.tandem/settings.json, or a
.venv in the shared root), else the default Python.

Code in a shared project was written by its members and runs with this
user's permissions: the app asks before the first run in each project.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Callable

from .files import MAX_TEXT_BYTES, FileError, ProjectFiles
from .interpreters import resolve_interpreter
from .kernels import KernelHub
from .runs import RunManager

PROJECT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_SHARED_FILES = 2000
MANIFEST = ".tandem/synced.json"
TRUST = ".tandem/trusted.json"


class SharedError(Exception):
    """A refused request about a shared project; the message is safe to show."""


class Workspace:
    def __init__(self, project_id: str, root: Path, interpreter: Callable[[], Path | None]):
        self.id = project_id
        self.files = ProjectFiles(root)
        self.runs = RunManager(self.files, interpreter)
        self.kernels = KernelHub(self.files.root, interpreter)

    @property
    def root(self) -> Path:
        return self.files.root

    def _manifest(self) -> dict:
        try:
            data = json.loads((self.root / MANIFEST).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def sync(self, files: dict) -> dict:
        """Write the project's current files; delete the ones it no longer has."""
        if not isinstance(files, dict) or len(files) > MAX_SHARED_FILES:
            raise SharedError("Too many files to run here.")
        targets = {}
        for rel, text in files.items():
            if not isinstance(rel, str) or not isinstance(text, str):
                raise SharedError("Shared files must be text.")
            if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
                raise SharedError(f"{rel} is too large to run here.")
            try:
                path = self.files.resolve(rel)
            except FileError as exc:
                raise SharedError(f"{rel}: {exc}") from None
            if path == self.root or path.relative_to(self.root).parts[0] == ".tandem":
                raise SharedError(f"{rel} isn't a project file name Tandem can use.")
            targets[rel] = (path, text)

        written, removed = [], []
        for rel, (path, text) in targets.items():
            data = text.encode("utf-8")
            try:
                if path.is_file() and path.read_bytes() == data:
                    continue
            except OSError:
                pass
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.rmtree(path)
            path.write_bytes(data)  # as saved: no newline translation
            written.append(rel)

        # Files the project had last time and no longer has. Files a run made
        # were never in the project, so they stay.
        before = self._manifest().get("files", [])
        for rel in before if isinstance(before, list) else []:
            if not isinstance(rel, str) or rel in targets:
                continue
            try:
                path = self.files.resolve(rel)
            except FileError:
                continue
            if path.is_file():
                path.unlink()
                removed.append(rel)
                # Leave no empty folders behind.
                parent = path.parent
                while parent != self.root and parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
                    parent = parent.parent

        manifest = self.root / MANIFEST
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"files": sorted(targets)}, indent=1), encoding="utf-8")
        return {"root": str(self.root), "written": written, "removed": removed}


class SharedWorkspaces:
    def __init__(self, root: Path, cli_python: str | None = None):
        self.root = root.expanduser().resolve()
        self.cli_python = cli_python
        self.open: dict[str, Workspace] = {}

    # The Python for shared projects: chosen for all of them, else the default.
    def interpreter_and_source(self) -> tuple[Path | None, str]:
        python, source = resolve_interpreter(self.root, self.cli_python)
        if source == "project setting":
            source = "chosen for shared projects"
        elif source.startswith("project environment"):
            source = "shared projects' environment (.venv)"
        return python, source

    def interpreter(self) -> Path | None:
        return self.interpreter_and_source()[0]

    def get(self, project_id: str, create: bool = False) -> Workspace:
        if not isinstance(project_id, str) or not PROJECT_ID.match(project_id):
            raise SharedError("That isn't a shared project.")
        ws = self.open.get(project_id)
        if ws is None:
            folder = self.root / project_id
            if not folder.is_dir():
                if not create:
                    raise SharedError("This shared project has no working copy here yet.")
                folder.mkdir(parents=True, exist_ok=True)
            ws = Workspace(project_id, folder, self.interpreter)
            self.open[project_id] = ws
        return ws

    def sync(self, project_id: str, files: dict) -> dict:
        return self.get(project_id, create=True).sync(files)

    async def close(self, project_id: str) -> None:
        """Leaving a shared project: stop its run and shut down its kernels."""
        ws = self.open.pop(project_id, None)
        if ws is None:
            return
        if ws.runs.current is not None:
            await ws.runs.stop(ws.runs.current.id, force=True)
        await ws.kernels.shutdown_all()

    async def shutdown(self) -> None:
        for project_id in list(self.open):
            await self.close(project_id)

    # Running code from a shared project on this computer: asked once per project.
    def _trust(self) -> dict:
        try:
            data = json.loads((self.root / TRUST).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def trusted(self, project_id: str) -> bool:
        if not PROJECT_ID.match(project_id or ""):
            return False
        return bool(self._trust().get(project_id))

    def set_trusted(self, project_id: str, trusted: bool) -> None:
        if not PROJECT_ID.match(project_id or ""):
            raise SharedError("That isn't a shared project.")
        data = self._trust()
        if trusted:
            data[project_id] = True
        else:
            data.pop(project_id, None)
        path = self.root / TRUST
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=1), encoding="utf-8")
