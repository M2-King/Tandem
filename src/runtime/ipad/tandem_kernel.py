"""Tandem for iPad: notebook cells in one long-lived Python (Pyodide).

Cells run in the notebook's own namespace, as in IPython:
* the value of a cell's last expression is shown (Out[n]);
* objects with rich forms (_repr_html_ for pandas tables, images, Markdown)
  are shown in their richest form;
* matplotlib figures appear below the cell (PNG, like Jupyter's inline);
* input() asks in the notebook; errors show their traceback with the cell's
  own lines.

Outputs go to the host as nbformat outputs (JSON) through _tandem_kernel_host.
"""

import ast
import base64
import builtins
import io
import json
import linecache
import sys
import warnings

import _tandem_kernel_host as host

namespace = {"__name__": "__main__", "__builtins__": builtins}
_count = 0
_INTERRUPTED = "\x00interrupt"


def _send(output):
    sys.stdout.flush()
    sys.stderr.flush()
    host.output(json.dumps(output))


def _is_figure(obj):
    cls = type(obj)
    return cls.__name__ == "Figure" and cls.__module__.startswith("matplotlib")


def _png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, bbox_inches="tight", facecolor="white")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _bundle(obj):
    data = {}
    if _is_figure(obj):
        data["image/png"] = _png(obj)
    for method, mime in (("_repr_html_", "text/html"), ("_repr_markdown_", "text/markdown"),
                         ("_repr_svg_", "image/svg+xml"), ("_repr_png_", "image/png"), ("_repr_jpeg_", "image/jpeg")):
        fn = getattr(obj, method, None)
        if not callable(fn) or isinstance(obj, type):
            continue
        try:
            value = fn()
        except Exception:
            continue
        if isinstance(value, tuple):
            value = value[0]
        if value is None:
            continue
        if isinstance(value, bytes):
            value = base64.b64encode(value).decode("ascii")
        data.setdefault(mime, value)
    try:
        data["text/plain"] = repr(obj)
    except Exception as exc:
        data["text/plain"] = f"<repr failed: {exc}>"
    return data


def display(*objs, raw=False, **_):
    for obj in objs:
        _send({"output_type": "display_data", "data": obj if raw else _bundle(obj), "metadata": {}})


def clear_output(wait=False):
    host.clear(bool(wait))


class _Rich:
    def __init__(self, data=None, url=None, filename=None):
        self.data = data

    def __repr__(self):
        return f"<{type(self).__name__} object>"


class HTML(_Rich):
    def _repr_html_(self):
        return self.data


class Markdown(_Rich):
    def _repr_markdown_(self):
        return self.data


class SVG(_Rich):
    def _repr_svg_(self):
        return self.data


# `from IPython.display import display, HTML, Markdown` works as in Jupyter.
# Provided only when code imports IPython and no real IPython is installed
# (a finder at the end of the import path), so libraries that look for
# IPython (matplotlib, pandas, …) don't find a half one. get_ipython()
# returns None: "not running inside IPython".
_STUB = {
    "IPython": {"get_ipython": lambda: None, "version_info": (0, 0, 0), "__version__": "0.0.0"},
    "IPython.display": {"display": display, "clear_output": clear_output, "HTML": HTML, "Markdown": Markdown, "SVG": SVG},
}


class _StubLoader:
    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__dict__.update(_STUB[module.__name__])
        if module.__name__ == "IPython":
            module.__path__ = []


class _StubFinder:
    @staticmethod
    def find_spec(name, path=None, target=None):
        if name not in _STUB:
            return None
        import importlib.machinery

        return importlib.machinery.ModuleSpec(name, _StubLoader(), is_package=name == "IPython")


sys.meta_path.append(_StubFinder)
builtins.display = display


def show_figures():
    """matplotlib figures created so far, shown below the cell, then closed."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        _send({"output_type": "display_data", "data": {"image/png": _png(fig), "text/plain": repr(fig)}, "metadata": {}})
    plt.close("all")


def _input(prompt=""):
    sys.stdout.flush()
    value = host.read_input(str(prompt))
    if value is None:
        raise EOFError("EOF when reading a line")
    if value == _INTERRUPTED:
        raise KeyboardInterrupt
    return value


builtins.input = _input
warnings.filterwarnings("ignore", message=".*non-interactive.*")


def _error(exc):
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
        tb = tb.tb_next  # this module's own frames
    import traceback

    text = "".join(traceback.format_exception(type(exc), exc, tb)).rstrip()
    _send({"output_type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": text.split("\n")})


def run_cell(code):
    """Run one cell. Returns "ok" or "error"."""
    global _count
    _count += 1
    count = _count
    host.count(count)
    name = f"<cell {count}>"
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)  # source lines in tracebacks
    try:
        tree = ast.parse(code, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, name, "exec"), namespace)
        result = eval(compile(last, name, "eval"), namespace) if last is not None else None
        show_figures()
        if result is not None and not code.rstrip().endswith(";"):
            namespace["_"] = result
            namespace[f"_{count}"] = result
            _send({"output_type": "execute_result", "data": _bundle(result), "metadata": {}, "execution_count": count})
        return "ok"
    except SystemExit:
        return "ok"
    except BaseException as exc:  # KeyboardInterrupt from Interrupt included
        show_figures()
        _error(exc)
        return "error"
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
