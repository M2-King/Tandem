"""Entry point of the bundled runtime (tandem-runtime.exe) that the desktop app starts."""

import sys

from tandem_runtime.cli import main

if __name__ == "__main__":
    sys.exit(main())
