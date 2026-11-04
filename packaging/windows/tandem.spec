# PyInstaller spec for Tandem.exe: one file, console window (closing it stops Tandem).
# Build from the repository root after `npm run build`:
#     pyinstaller --noconfirm packaging/windows/tandem.spec
import os
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
SUPPORT = os.path.join(ROOT, "runtime", "tandem_runtime", "support")

a = Analysis(
    [os.path.join(SPECPATH, "tandem_app.py")],
    pathex=[os.path.join(ROOT, "runtime")],
    datas=[
        (os.path.join(SUPPORT, "tandem_run.py"), "tandem_runtime/support"),
        (os.path.join(SUPPORT, "tandem_mpl.py"), "tandem_runtime/support"),
        (os.path.join(ROOT, "dist"), "ui"),
    ],
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets"),
    excludes=["pytest", "numpy", "pandas", "matplotlib", "IPython"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="Tandem",
    icon=os.path.join(SPECPATH, "tandem.ico"),
    console=True,
    upx=False,
)
