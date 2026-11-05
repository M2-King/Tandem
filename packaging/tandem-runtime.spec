# PyInstaller spec for the Python runtime bundled inside the desktop app.
# One folder (not one file): a single process the app can stop cleanly.
# Build from the repository root after `npm run build`:
#     pyinstaller --noconfirm --distpath out packaging/tandem-runtime.spec
import os
from PyInstaller.utils.hooks import collect_submodules, copy_metadata

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
    + copy_metadata("jupyter_client") + copy_metadata("jupyter_core") + copy_metadata("pyzmq"),
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets")
    + collect_submodules("jupyter_client") + collect_submodules("jupyter_core") + collect_submodules("zmq"),
    excludes=["pytest", "numpy", "pandas", "matplotlib", "IPython", "tkinter"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="tandem-runtime",
          icon=os.path.join(SPECPATH, "windows", "tandem.ico"), console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="tandem-runtime", upx=False)
