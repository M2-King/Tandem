"""Runs one project script for Tandem, inside the project's own interpreter.

Started as:  <project python> -u tandem_run.py <script> [args...]

The script runs as __main__, exactly as `python script.py` would, with the
same sys.argv and sys.path[0]. This wrapper only adds a side channel (a
loopback connection to the runtime, at TANDEM_EVENT_ADDR, opened with the
run's key from TANDEM_EVENT_KEY) that reports, as JSON lines:

* figures shown with matplotlib (see tandem_mpl.py)
* a summary of the script's top-level variables when it ends
* per-model metrics, if the script keeps them in a variable named `results`
* in Step through and Debug runs, where execution paused (line, call stack,
  variables); the runtime answers with next / step / out / continue on the
  same connection. The debugger is the standard library's bdb, so this runs
  on any Python Tandem supports without installing anything.

Nothing is added to the script's stdout or stderr, except that a traceback
starts at the script's own code instead of this file.

This file must run on every Python Tandem supports (3.11+) using only the
standard library.
"""

import bdb
import builtins
import json
import math
import os
import reprlib
import sys
import traceback
import types

_EVENTS = None
_COMMANDS = None  # commands from the runtime (debug runs)


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
    hidden = {os.path.abspath(__file__), os.path.abspath(bdb.__file__)}
    while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) in hidden:
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


class _InjectedChannel:
    """Pyodide (Tandem for iPad): the host provides the channel as a module
    instead of a socket. Same interface as the socket files."""

    def __init__(self, module):
        self.module = module

    def write(self, text):
        self.module.emit(text)

    def flush(self):
        pass

    def readline(self):
        return self.module.read_command() or ""


def _connect_events():
    """Open the side channel; the variables are removed so child processes
    of the script never see the key."""
    global _EVENTS, _COMMANDS
    injected = None
    if sys.platform == "emscripten":  # Pyodide: the host registers the channel as a module
        try:
            import _tandem_channel as injected
        except ImportError:
            injected = None
    if injected is not None:
        _EVENTS = _COMMANDS = _InjectedChannel(injected)
        return
    address = os.environ.pop("TANDEM_EVENT_ADDR", "")
    key = os.environ.pop("TANDEM_EVENT_KEY", "")
    if not address or not key:
        return
    import socket

    host, _, port = address.rpartition(":")
    try:
        sock = socket.create_connection((host, int(port)), timeout=10)
        sock.settimeout(None)
        _EVENTS = sock.makefile("w", encoding="utf-8", newline="\n")
        _EVENTS.write(key + "\n")
        _EVENTS.flush()
        _COMMANDS = sock.makefile("r", encoding="utf-8", newline="\n")
    except (OSError, ValueError):
        _EVENTS = None


_SKIP_PARTS = {".venv", "venv", "env", "site-packages", "dist-packages", "__pycache__", ".tandem"}


class Debugger(bdb.Bdb):
    """Pauses only in the project's own code (never in libraries) and asks the
    runtime what to do next."""

    def __init__(self, root, mode, breakpoints):
        super().__init__()
        self.root = os.path.abspath(root)
        self.mode = mode  # 'step': stop at the first line; 'debug': run to a breakpoint
        self.first = True
        self.pauses = 0
        self.set_breakpoints(breakpoints)

    def set_breakpoints(self, breakpoints):
        self.clear_all_breaks()
        self.points = set()
        for path, line in breakpoints:
            path = os.path.abspath(path)
            self.points.add((path, int(line)))
            self.set_break(path, int(line))

    def in_project(self, frame):
        name = os.path.abspath(frame.f_code.co_filename)
        if not name.startswith(self.root + os.sep):
            return False
        parts = set(os.path.relpath(name, self.root).split(os.sep))
        return not (parts & _SKIP_PARTS)

    def stop_here(self, frame):
        return self.in_project(frame) and super().stop_here(frame)

    def user_line(self, frame):
        if not self.in_project(frame):
            return
        here = (os.path.abspath(frame.f_code.co_filename), frame.f_lineno)
        at_breakpoint = here in self.points
        if self.first:
            self.first = False
            if self.mode == "debug" and not at_breakpoint:
                self.set_continue()
                return
        self.pause(frame, "breakpoint" if at_breakpoint else "step")

    def rel(self, filename):
        return os.path.relpath(os.path.abspath(filename), self.root).replace(os.sep, "/")

    def pause(self, frame, reason):
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        stack = []
        f = frame
        while f is not None:
            if self.in_project(f):
                stack.append({"path": self.rel(f.f_code.co_filename), "line": f.f_lineno, "function": f.f_code.co_name})
            f = f.f_back
        function = frame.f_code.co_name
        local_scope = None if function == "<module>" else _variables(frame.f_locals)
        self.pauses += 1
        emit({"type": "paused", "reason": reason, "path": self.rel(frame.f_code.co_filename), "line": frame.f_lineno,
              "function": function, "stack": stack, "locals": local_scope, "globals": _variables(frame.f_globals),
              "count": self.pauses})
        while True:
            line = _COMMANDS.readline() if _COMMANDS else ""
            if not line:
                raise bdb.BdbQuit  # the runtime went away
            try:
                command = json.loads(line)
            except ValueError:
                continue
            cmd = command.get("cmd")
            if cmd == "breakpoints":
                self.set_breakpoints(command.get("list") or [])
                continue
            emit({"type": "resumed"})
            if cmd == "next":
                self.set_next(frame)
            elif cmd == "step":
                self.set_step()
            elif cmd == "out":
                self.set_return(frame)
            elif cmd == "continue":
                self.set_continue()
            else:  # stop
                self.set_quit()
            return


def main():
    if os.environ.pop("TANDEM_WATCH_PARENT", "") == "1":
        _watch_parent()
    if sys.platform == "win32":
        # Stop sends CTRL_BREAK on Windows: make it a KeyboardInterrupt, like Ctrl+C.
        import signal

        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    _connect_events()
    # Keep "\n" line endings on Windows too, so output reads the same everywhere.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(newline="\n")
        except (AttributeError, ValueError):
            pass
    # The matplotlib backend (tandem_mpl) reports figures through this.
    sys.modules["_tandem_events"] = types.SimpleNamespace(emit=emit)

    debug_mode = os.environ.pop("TANDEM_DEBUG", "")
    try:
        breakpoints = json.loads(os.environ.pop("TANDEM_BREAKPOINTS", "[]"))
    except ValueError:
        breakpoints = []
    script = os.path.abspath(sys.argv[1])
    project_root = os.environ.pop("TANDEM_PROJECT_ROOT", "") or os.path.dirname(script)
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
        if debug_mode in ("step", "debug") and _COMMANDS is not None:
            Debugger(project_root, debug_mode, breakpoints).run(code, namespace)
        else:
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
