"""Put Pyodide and the packages Tandem ships into one folder.

    python ipad/fetch_pyodide.py <out folder> [--no-packages]

Core files come from the `pyodide` npm package (node_modules/pyodide). The
packages Tandem includes (numpy, pandas, matplotlib, scikit-learn, micropip
and everything they need) are downloaded from Pyodide's CDN, so they work
offline on the iPad. Any other package Pyodide has is downloaded the first
time a script imports it.
"""

import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json", "pyodide.js"]
SHIPPED = ["numpy", "pandas", "matplotlib", "scikit-learn", "micropip", "jedi"]  # jedi: code completion


def closure(lock: dict, names: list[str]) -> list[str]:
    seen, todo = [], list(names)
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.append(name)
        todo.extend(lock["packages"][name].get("depends", []))
    return seen


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    src = ROOT / "node_modules" / "pyodide"
    version = json.loads((src / "package.json").read_text())["version"]
    for name in CORE:
        shutil.copy2(src / name, out / name)
    if "--no-packages" in sys.argv:
        return
    lock = json.loads((src / "pyodide-lock.json").read_text())
    cdn = f"https://cdn.jsdelivr.net/pyodide/v{version}/full/"
    total = 0
    for name in sorted(closure(lock, SHIPPED)):
        file_name = lock["packages"][name]["file_name"]
        target = out / file_name
        if not target.exists():
            with urllib.request.urlopen(cdn + file_name, timeout=120) as r:
                target.write_bytes(r.read())
        total += target.stat().st_size
        print(f"{name:24} {target.stat().st_size / 1e6:6.1f} MB")
    print(f"packages: {total / 1e6:.1f} MB (Pyodide {version})")


if __name__ == "__main__":
    main()
