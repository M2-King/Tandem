# PyInstaller spec for the Python runtime bundled inside the desktop app.
# One folder (not one file): a single process the app can stop cleanly.
# Build from the repository root after `npm run build`:
#     pyinstaller --noconfirm --distpath out packaging/tandem-runtime.spec
import os
import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
SUPPORT = os.path.join(ROOT, "runtime", "tandem_runtime", "support")

a = Analysis(
    [os.path.join(SPECPATH, "runtime_entry.py")],
    pathex=[os.path.join(ROOT, "runtime")],
    datas=[
        (os.path.join(SUPPORT, "tandem_run.py"), "tandem_runtime/support"),
        (os.path.join(SUPPORT, "tandem_mpl.py"), "tandem_runtime/support"),
        (os.path.join(ROOT, "dist"), "ui"),
    ]
    # jupyter_client finds its kernel launcher through package metadata.
    + copy_metadata("jupyter_client") + copy_metadata("jupyter_core") + copy_metadata("pyzmq")
    # Jedi (code completion) reads its type stubs from disk and starts a helper in
    # the project's Python from its own source files: ship them as real files.
    + collect_data_files("jedi", include_py_files=True) + collect_data_files("parso", include_py_files=True),
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets")
    + collect_submodules("jupyter_client") + collect_submodules("jupyter_core") + collect_submodules("zmq")
    + collect_submodules("jedi") + collect_submodules("parso"),
    excludes=["pytest", "numpy", "pandas", "matplotlib", "IPython", "tkinter"],
)
pyz = PYZ(a.pure)
# The .ico is for Windows; elsewhere the runtime is a plain command inside the app.
ICON = os.path.join(SPECPATH, "windows", "tandem.ico") if sys.platform == "win32" else None
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="tandem-runtime",
          icon=ICON, console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="tandem-runtime", upx=False)
