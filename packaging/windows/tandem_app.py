"""Entry point of the packaged Windows app (Tandem.exe).

Double-clicked: asks for a project folder, then starts the local runtime and
opens Tandem in the browser. With arguments it behaves like the `tandem`
command (for example `Tandem.exe open C:\\code\\project`).
"""

import json
import os
import sys
from pathlib import Path

from tandem_runtime.cli import main

STATE = Path(os.environ.get("APPDATA", Path.home())) / "Tandem" / "last-project.json"


def _last_folder() -> str:
    try:
        return json.loads(STATE.read_text(encoding="utf-8")).get("folder", "")
    except (OSError, ValueError):
        return ""


def _remember(folder: str) -> None:
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"folder": folder}), encoding="utf-8")
    except OSError:
        pass


def _choose_folder() -> str:
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    folder = filedialog.askdirectory(title="Choose a project folder for Tandem",
                                     initialdir=_last_folder() or str(Path.home()), mustexist=True)
    root.destroy()
    return folder


def run() -> int:
    if len(sys.argv) > 1:
        return main(sys.argv[1:])
    print("Tandem: choose a project folder in the window that just opened…", flush=True)
    folder = _choose_folder()
    if not folder:
        print("No folder chosen. Closing.")
        return 0
    _remember(folder)
    code = main(["open", folder])
    if code:
        input("\nPress Enter to close this window.")
    return code


if __name__ == "__main__":
    sys.exit(run())
