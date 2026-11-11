"""Tandem for iPad: code completion with Jedi inside Pyodide.

Jedi runs in this Python (there are no other processes on iPad); it reads
the code and the packages Pyodide has loaded. Same answers as the desktop
runtime's completion.py.
"""

import json
import time

import jedi

ENV = jedi.InterpreterEnvironment()
PROJECT = jedi.Project("/project", added_sys_path=["/project"])


def _script(path, text):
    rel = path or "untitled.py"
    if rel.endswith(".ipynb"):
        rel += ".py"
    return jedi.Script(code=text, path="/project/" + rel, environment=ENV, project=PROJECT)


def _signature(c):
    try:
        sigs = c.get_signatures()
    except Exception:
        return None
    if not sigs:
        return None
    text = sigs[0].to_string()
    return text if len(text) <= 300 else text[:297] + "…"


def complete(path, text, line, column):
    try:
        found = _script(path, text).complete(line, column)
    except Exception as exc:
        return json.dumps({"items": [], "error": str(exc)})
    items, started = [], time.monotonic()
    for c in found[:200]:
        item = {"name": c.name, "type": c.type, "description": c.description}
        if c.type in ("function", "class") and time.monotonic() - started < 0.35:
            sig = _signature(c)
            if sig:
                item["signature"] = sig
        items.append(item)
    return json.dumps({"items": items})


def detail(path, text, line, column, name):
    try:
        match = next((c for c in _script(path, text).complete(line, column) if c.name == name), None)
    except Exception:
        match = None
    if match is None:
        return json.dumps({"signature": None, "doc": None})
    try:
        doc = match.docstring(raw=True)
    except Exception:
        doc = ""
    return json.dumps({"signature": _signature(match), "doc": (doc or "")[:6000], "type": match.type})
