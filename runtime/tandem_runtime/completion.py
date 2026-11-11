"""Code completion for the editor (what can follow "text." and the like),
with the signature and documentation of each suggestion, from Jedi.

Jedi reads the project's code and asks the project's own Python (the
selected environment) about installed packages, so `numpy.` lists numpy's
functions as they are in that environment. Nothing in the project runs.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

LOCK = threading.Lock()  # Jedi isn't thread-safe
_ENVIRONMENTS: dict[str, object] = {}
DETAIL_BUDGET = 0.35  # seconds spent on inline signatures per request
MAX_ITEMS = 200


def _environment(python: Path | None):
    import jedi

    if python is None:
        return None
    key = str(python)
    if key not in _ENVIRONMENTS:
        try:
            _ENVIRONMENTS[key] = jedi.create_environment(key, safe=False)
        except Exception:
            _ENVIRONMENTS[key] = None  # fall back to Jedi's own knowledge (typeshed)
    return _ENVIRONMENTS[key]


def _script(root: Path, python: Path | None, path: str, text: str):
    import jedi

    rel = path or "untitled.py"
    if rel.endswith(".ipynb"):  # a notebook: the cells' code, as one script
        rel += ".py"
    project = jedi.Project(str(root), added_sys_path=[str(root)], smart_sys_path=True)
    return jedi.Script(code=text, path=str(root / rel), environment=_environment(python), project=project)


def _signature(completion) -> str | None:
    try:
        sigs = completion.get_signatures()
    except Exception:
        return None
    if not sigs:
        return None
    text = sigs[0].to_string()
    return text if len(text) <= 300 else text[:297] + "…"


def complete(root: Path, python: Path | None, path: str, text: str, line: int, column: int) -> dict:
    """Suggestions at (line, column): line from 1, column from 0."""
    with LOCK:
        script = _script(root, python, path, text)
        try:
            found = script.complete(line, column)
        except Exception as exc:  # e.g. a position past the end while typing fast
            return {"items": [], "error": str(exc)}
        items = []
        started = time.monotonic()
        for c in found[:MAX_ITEMS]:
            item = {"name": c.name, "type": c.type, "description": c.description}
            # Inline signatures (like PyCharm) for the first suggestions, within a time budget.
            if c.type in ("function", "class") and time.monotonic() - started < DETAIL_BUDGET:
                sig = _signature(c)
                if sig:
                    item["signature"] = sig
            items.append(item)
        return {"items": items}


def detail(root: Path, python: Path | None, path: str, text: str, line: int, column: int, name: str) -> dict:
    """Signature and documentation of one suggestion (shown when it is selected)."""
    with LOCK:
        script = _script(root, python, path, text)
        try:
            match = next((c for c in script.complete(line, column) if c.name == name), None)
        except Exception:
            match = None
        if match is None:
            return {"signature": None, "doc": None}
        try:
            doc = match.docstring(raw=True)
        except Exception:
            doc = ""
        return {"signature": _signature(match), "doc": (doc or "")[:6000], "type": match.type,
                "module": getattr(match, "module_name", None)}
