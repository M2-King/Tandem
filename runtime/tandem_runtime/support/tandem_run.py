"""Runs one project script for Tandem, inside the project's own interpreter.

Started as:  <project python> -u tandem_run.py <script> [args...]

The script runs as __main__, exactly as `python script.py` would, with the
same sys.argv and sys.path[0]. This wrapper only adds a side channel (a pipe
whose number is in TANDEM_EVENT_FD) that reports, as JSON lines:

* figures shown with matplotlib (see tandem_mpl.py)
* a summary of the script's top-level variables when it ends
* per-model metrics, if the script keeps them in a variable named `results`

Nothing is added to the script's stdout or stderr, except that a traceback
starts at the script's own code instead of this file.

This file must run on every Python Tandem supports (3.11+) using only the
standard library.
"""

import builtins
import json
import math
import os
import reprlib
import sys
import traceback
import types

_EVENTS = None


def emit(event):
    if _EVENTS is None:
        return
    try:
        _EVENTS.write(json.dumps(event, default=str) + "\n")
        _EVENTS.flush()
    except (OSError, ValueError):
        pass


_repr = reprlib.Repr()
_repr.maxstring = 120
_repr.maxother = 120
_repr.maxlist = 8
_repr.maxdict = 8


def _type_name(value):
    return type(value).__name__


def _summary(value):
    """Short, human-readable description of a value (never the whole value)."""
    mod = type(value).__module__ or ""
    shape = getattr(value, "shape", None)
    if mod.startswith("pandas") and type(value).__name__ == "DataFrame":
        rows, cols = value.shape
        names = ", ".join(map(str, list(value.columns)[:6]))
        more = ", …" if cols > 6 else ""
        return f"{rows} rows × {cols} columns ({names}{more})"
    if mod.startswith("pandas") and type(value).__name__ == "Series":
        head = ", ".join(_repr.repr(v) for v in value.head(3).tolist())
        return f"{len(value)} values: {head}{', …' if len(value) > 3 else ''}"
    if mod.startswith("numpy") and shape is not None:
        try:
            flat = value.ravel()[:4].tolist()
            preview = ", ".join(_repr.repr(v) for v in flat)
            return f"shape {tuple(shape)}, {value.dtype}: [{preview}{', …' if value.size > 4 else ''}]"
        except Exception:
            return f"shape {tuple(shape)}"
    if isinstance(value, (types.FunctionType, types.BuiltinFunctionType)):
        return f"<function {value.__name__}>"
    if isinstance(value, type):
        return f"<class {value.__name__}>"
    try:
        return _repr.repr(value)
    except Exception:
        return f"<{_type_name(value)}>"


def _variables(namespace):
    out = []
    for name, value in namespace.items():
        if name.startswith("__") or isinstance(value, types.ModuleType):
            continue
        out.append({"name": name, "type": _type_name(value), "value": _summary(value)})
        if len(out) >= 200:
            break
    return out


_METRIC_KEYS = {"mae": "mae", "rmse": "rmse", "r2": "r2", "r²": "r2", "r^2": "r2", "r2_score": "r2"}


def _metrics(namespace):
    """Per-model metrics, only if the script keeps them in `results`:
    {model: {"MAE": .., "RMSE": .., "R2": ..}} or a DataFrame with models as rows."""
    results = namespace.get("results")
    if results is None:
        return None
    if type(results).__name__ == "DataFrame":
        try:
            results = results.to_dict("index")
        except Exception:
            return None
    if not isinstance(results, dict):
        return None
    out = {}
    for model, values in results.items():
        if not isinstance(values, dict):
            continue
        row = {}
        for key, value in values.items():
            k = _METRIC_KEYS.get(str(key).strip().lower())
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if k and math.isfinite(number):
                row[k] = number
        if row:
            out[str(model)] = row
    return out or None


def _print_exception(exc):
    """Print the traceback as Python would, without this wrapper's frame."""
    tb = exc.__traceback__
    here = os.path.abspath(__file__)
    while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) == here:
        tb = tb.tb_next
    traceback.print_exception(type(exc), exc, tb, file=sys.stderr)


def _watch_parent():
    """If the Tandem runtime dies (crash, kill -9), end this run and anything
    it started, instead of leaving it running unattended."""
    import signal
    import threading
    import time

    parent = os.getppid()

    def watch():
        while True:
            time.sleep(0.5)
            if os.getppid() != parent:
                try:
                    os.killpg(os.getpgrp(), signal.SIGTERM)
                finally:
                    os._exit(143)

    threading.Thread(target=watch, name="tandem-parent-watch", daemon=True).start()


def main():
    global _EVENTS
    if os.environ.pop("TANDEM_WATCH_PARENT", "") == "1":
        _watch_parent()
    fd = int(os.environ.pop("TANDEM_EVENT_FD", "-1"))
    if fd >= 0:
        _EVENTS = os.fdopen(fd, "w", buffering=1, encoding="utf-8")
    # The matplotlib backend (tandem_mpl) reports figures through this.
    sys.modules["_tandem_events"] = types.SimpleNamespace(emit=emit)

    script = os.path.abspath(sys.argv[1])
    sys.argv = sys.argv[1:]
    sys.path[0] = os.path.dirname(script)

    module = types.ModuleType("__main__")
    module.__file__ = script
    module.__builtins__ = builtins
    sys.modules["__main__"] = module
    namespace = module.__dict__

    exit_code = 0
    try:
        with open(script, "rb") as f:
            source = f.read()
        code = compile(source, script, "exec")
        exec(code, namespace)
    except SystemExit as exc:
        code_value = exc.code
        if code_value is None:
            exit_code = 0
        elif isinstance(code_value, int):
            exit_code = code_value
        else:
            print(code_value, file=sys.stderr)
            exit_code = 1
    except KeyboardInterrupt as exc:
        _print_exception(exc)
        exit_code = 130
    except BaseException as exc:  # the script's own error
        _print_exception(exc)
        exit_code = 1
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        emit({"type": "variables", "variables": _variables(namespace)})
        metrics = _metrics(namespace)
        if metrics:
            emit({"type": "metrics", "metrics": metrics})
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
