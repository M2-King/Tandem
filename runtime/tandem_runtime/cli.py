"""`tandem` command: start the local runtime for a project folder."""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from .security import AccessPolicy, new_token
from .server import create_app

DEFAULT_PORT = 8765
DEFAULT_UI = Path(__file__).resolve().parents[2] / "dist"


def _bind(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))  # loopback only: never reachable from the network
    sock.listen(64)
    return sock


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tandem", description="Run Tandem with real Python on this computer.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (("open", "start the runtime and open Tandem in your browser"),
                            ("serve", "start the runtime without opening a browser (for desktop shells)")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("project", nargs="?", default=".", help="project folder (default: current folder)")
        p.add_argument("--port", type=int, default=DEFAULT_PORT if name == "open" else 0,
                       help="port on 127.0.0.1 (0 picks a free one)")
        p.add_argument("--python", help="interpreter to use when the project has no environment of its own")
        p.add_argument("--ui", type=Path, default=DEFAULT_UI, help="folder with the built Tandem UI")
        p.add_argument("--print-url", action="store_true", help="print only the URL (for desktop shells)")
    args = parser.parse_args(argv)

    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        print(f"tandem: {project} is not a folder", file=sys.stderr)
        return 2
    try:
        sock = _bind(args.port)
    except OSError as exc:
        print(f"tandem: can't listen on 127.0.0.1:{args.port} ({exc}). Try --port 0.", file=sys.stderr)
        return 2
    port = sock.getsockname()[1]
    policy = AccessPolicy(token=new_token(), port=port)
    ui_dir = args.ui.resolve() if args.ui and args.ui.exists() else None
    app = create_app(project, policy, ui_dir, cli_python=args.python)

    url = f"http://127.0.0.1:{port}/"
    if args.print_url:
        print(url, flush=True)
    else:
        print(f"Tandem runtime for {project}\n  {url}\n"
              "  Code runs on this computer with your permissions. This is not a sandbox.\n"
              "  Press Ctrl+C to stop.", flush=True)
        if ui_dir is None:
            print("  The UI isn't built yet: run `npm run build` in the Tandem folder.", flush=True)
    if args.command == "open":
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="on"))
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
