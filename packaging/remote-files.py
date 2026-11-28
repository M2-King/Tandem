"""Builds the files the Tandem apps install on SSH servers, into out/remote:
the runtime wheel (tandem_runtime-*.whl), and runtime/remote/bootstrap.sh,
constraints.txt and lite.py. The desktop app ships them in
resources/remote; the iPad app in its bundle.

    python packaging/remote-files.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out" / "remote"

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)
subprocess.run([sys.executable, "-m", "pip", "wheel", str(ROOT / "runtime"), "--no-deps", "--quiet", "-w", str(OUT)], check=True)
for name in ("bootstrap.sh", "constraints.txt", "lite.py"):
    shutil.copyfile(ROOT / "runtime" / "remote" / name, OUT / name)
wheels = list(OUT.glob("tandem_runtime-*.whl"))
assert len(wheels) == 1, wheels
print("out/remote:", ", ".join(sorted(p.name for p in OUT.iterdir())))
