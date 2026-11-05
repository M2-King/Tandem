"""Project files on disk, confined to the project folder."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

# Folders that are never part of the editable project.
SKIP_DIRS = {".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", "node_modules", ".tandem",
             ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode"}
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_FILES = 2000
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class FileError(Exception):
    """A request the file API refuses; the message is safe to show."""


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class ProjectFiles:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def resolve(self, rel: str) -> Path:
        """Absolute path for a project-relative path, refusing anything outside the project."""
        if not rel or rel.startswith(("/", "\\")) or ":" in rel.split("/")[0]:
            raise FileError("Paths must be relative to the project folder.")
        target = (self.root / rel).resolve()
        if target != self.root and self.root not in target.parents:
            raise FileError("That path is outside the project folder.")
        return target

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def list(self) -> list[dict]:
        """Project files, sorted, with size and whether they are readable text."""
        out: list[dict] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
            for name in sorted(filenames):
                if name.startswith(".") and name not in {".gitignore", ".env.example"}:
                    continue
                full = Path(dirpath) / name
                try:
                    # Skip symlinks that point outside the project.
                    self.resolve(full.relative_to(self.root).as_posix())
                    size = full.stat().st_size
                except (FileError, OSError):
                    continue
                out.append({"path": full.relative_to(self.root).as_posix(), "size": size})
                if len(out) >= MAX_FILES:
                    return out
        return out

    def read(self, rel: str) -> dict:
        path = self.resolve(rel)
        if not path.is_file():
            raise FileError(f"{rel} doesn't exist.")
        size = path.stat().st_size
        if size > MAX_TEXT_BYTES:
            return {"path": rel, "text": None, "reason": "too-large", "size": size}
        data = path.read_bytes()
        if b"\x00" in data[:8192]:
            return {"path": rel, "text": None, "reason": "binary", "size": size}
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return {"path": rel, "text": None, "reason": "not-utf8", "size": size}
        return {"path": rel, "text": text, "hash": content_hash(text), "size": size}

    def write(self, rel: str, text: str, base_hash: str | None = None, create: bool = False) -> dict:
        """Write a text file. With base_hash, refuse if the file changed on disk since it was read."""
        path = self.resolve(rel)
        if path.exists() and not path.is_file():
            raise FileError(f"{rel} is a folder.")
        if create and path.exists():
            raise FileError(f"{rel} already exists.")
        if not create and not path.exists():
            raise FileError(f"{rel} doesn't exist.")
        if base_hash and path.exists():
            current = self.read(rel)
            if current.get("hash") and current["hash"] != base_hash:
                raise FileError(f"{rel} changed on disk since it was opened.")
        if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            raise FileError(f"{rel} is larger than 2 MB.")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tandem-tmp")
        tmp.write_bytes(text.encode("utf-8"))  # exact bytes: no newline translation on Windows
        os.replace(tmp, path)
        return {"path": rel, "hash": content_hash(text), "size": path.stat().st_size}

    def add(self, rel: str, data: bytes) -> dict:
        """Add a file brought in from elsewhere (any kind: code, data, images). Never overwrites."""
        path = self.resolve(rel)
        if path.exists():
            raise FileError(f"{rel} already exists.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise FileError(f"{rel} is larger than 25 MB.")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tandem-tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        return {"path": rel, "size": len(data)}
