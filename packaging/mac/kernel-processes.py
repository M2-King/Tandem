"""Diagnostics: the processes behind a notebook kernel, before and after it is
stopped, started the way the runtime starts it (tandem_runtime/kernels.py).

    python packaging/mac/kernel-processes.py <python with ipykernel>
"""

import asyncio
import os
import subprocess
import sys
import tempfile
import time

from jupyter_client.kernelspec import KernelSpec
from jupyter_client.manager import AsyncKernelManager


def tree(tag):
    rows = subprocess.run(["ps", "-axo", "pid,ppid,pgid,stat,command"], capture_output=True, text=True).stdout.splitlines()
    print(f"--- {tag}")
    print(rows[0])
    for row in rows[1:]:
        if "ipykernel" in row or "Python.app" in row:
            print(row[:220])


async def main(python):
    print("python:", python, "->", os.path.realpath(python))
    folder = tempfile.mkdtemp(prefix="kdiag-")
    km = AsyncKernelManager(connection_file=os.path.join(folder, "kernel.json"), ip=os.path.join(folder, "k"), transport="ipc")
    km._kernel_spec = KernelSpec(argv=[python, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                                 display_name="p", language="python", env={})
    await km.start_kernel(env=dict(os.environ), cwd=folder)
    kc = km.client()
    kc.start_channels()
    await kc.wait_for_ready(timeout=90)
    prov = km.provisioner
    print("started pid:", prov.process.pid, "pgid:", getattr(prov, "pgid", None))
    tree("running")
    kc.stop_channels()
    t = time.monotonic()
    await km.shutdown_kernel(now=True)
    print(f"shutdown_kernel took {time.monotonic() - t:.2f} s")
    time.sleep(2)
    tree("after shutdown_kernel(now=True)")


asyncio.run(main(sys.argv[1]))
