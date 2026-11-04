"""Matplotlib backend for Tandem runs (selected with MPLBACKEND=module://tandem_mpl).

plt.show() sends each open figure to Tandem as SVG, then closes it, like an
interactive window that was shown and closed. Rendering uses Agg, so
savefig() and everything else behave exactly as with the default backend.

For the preview only, default black text and white backgrounds are
recoloured to read on Tandem's dark glass; the original colours are restored
immediately afterwards, so the figure object and anything the script saves
are unchanged. Colours the script chose itself are left alone.
"""

import io
import sys

from matplotlib import colors as mcolors
from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg

_TEXT = "#d4d9e1"
_LINE = "#ffffff59"
_LEGEND_FACE = "#1f232dd9"
_count = 0


def _is(color, *candidates):
    try:
        rgba = mcolors.to_rgba(color)
    except (ValueError, TypeError):
        return False
    return any(rgba == mcolors.to_rgba(c) for c in candidates)


def _themed_svg(fig):
    """Render an SVG with dark-theme defaults, restoring the figure afterwards."""
    undo = []

    def swap(get, set_, new, *defaults):
        old = get()
        if _is(old, *defaults):
            undo.append((set_, old))
            set_(new)

    def text(t):
        swap(t.get_color, t.set_color, _TEXT, "black", "#000000")

    swap(fig.get_facecolor, fig.set_facecolor, (0, 0, 0, 0), "white")
    for t in fig.texts:
        text(t)
    if getattr(fig, "_suptitle", None) is not None:
        text(fig._suptitle)
    for ax in fig.axes:
        swap(ax.get_facecolor, ax.set_facecolor, (0, 0, 0, 0), "white")
        for spine in ax.spines.values():
            swap(spine.get_edgecolor, spine.set_edgecolor, _LINE, "black")
        for t in [ax.title, ax._left_title, ax._right_title, ax.xaxis.label, ax.yaxis.label, *ax.texts,
                  *ax.get_xticklabels(), *ax.get_yticklabels()]:
            text(t)
        for line in ax.xaxis.get_ticklines() + ax.yaxis.get_ticklines():
            swap(line.get_color, line.set_color, _LINE, "black")
        legend = ax.get_legend()
        if legend is not None:
            frame = legend.get_frame()
            swap(frame.get_facecolor, frame.set_facecolor, _LEGEND_FACE, "white")
            swap(frame.get_edgecolor, frame.set_edgecolor, "#ffffff26", "#cccccc", "0.8")
            for t in legend.get_texts():
                text(t)
            if legend.get_title() is not None:
                text(legend.get_title())
    try:
        buf = io.StringIO()
        fig.savefig(buf, format="svg", transparent=True, bbox_inches="tight")
        return buf.getvalue()
    finally:
        for set_, old in reversed(undo):
            set_(old)


def _title(fig):
    sup = getattr(fig, "_suptitle", None)
    if sup is not None and sup.get_text():
        return sup.get_text()
    for ax in fig.axes:
        if ax.get_title():
            return ax.get_title()
    return f"Figure {fig.number}" if getattr(fig, "number", None) else "Figure"


def _send(fig):
    global _count
    events = sys.modules.get("_tandem_events")
    if events is None:
        return
    _count += 1
    try:
        svg = _themed_svg(fig)
    except Exception as exc:  # report, don't break the user's program
        events.emit({"type": "figure-error", "message": f"{type(exc).__name__}: {exc}"})
        return
    events.emit({
        "type": "figure",
        "index": _count,
        "title": _title(fig),
        "panels": len(fig.axes),
        "format": "svg",
        "data": svg,
    })


class FigureManagerTandem(FigureManagerBase):
    def show(self):
        _send(self.canvas.figure)


class FigureCanvasTandem(FigureCanvasAgg):
    manager_class = FigureManagerTandem


@_Backend.export
class _BackendTandem(_Backend):
    FigureCanvas = FigureCanvasTandem
    FigureManager = FigureManagerTandem

    @staticmethod
    def show(*args, **kwargs):
        for manager in Gcf.get_all_fig_managers():
            _send(manager.canvas.figure)
        Gcf.destroy_all()
