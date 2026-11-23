# Projects on an SSH server

Tandem can open a folder on a server over SSH, like VS Code's Remote-SSH. You edit the server's files in Tandem; Run, Step through, Debug, notebooks, environments and the Terminal all use the **server's** Python, as your user on that server.

⋯ → **Connect to SSH server…** (Windows and Mac; iPad: see below). ⋯ → **Disconnect from …** goes back to the project on this device.

## How it works

1. The app signs in with a password or an SSH key and checks the server's identity (its host key): the first time it shows the key's SHA256 fingerprint to confirm, after that the key must match, or Tandem refuses to connect.
2. The first time (per Tandem version) it installs Tandem's runtime on the server in `~/.tandem/remote/<version>/`, using [runtime/remote/bootstrap.sh](../runtime/remote/bootstrap.sh) sent over the connection. The app uploads the runtime itself; its packages come from PyPI, pinned by [runtime/remote/constraints.txt](../runtime/remote/constraints.txt). The runtime's own Python is the server's `python3` if it's 3.11 or newer, otherwise a standalone Python 3.12 installed with [uv](https://github.com/astral-sh/uv) (a pinned release from PyPI, checked against its sha256). This takes about a minute once; later connections start in a second or two.
3. It starts the runtime for the chosen folder. It listens on the server's 127.0.0.1 only, with a new random token, and stops when the SSH connection closes.
4. The window shows **Tandem's UI from the app** through a small gateway on this device's 127.0.0.1 (`desktop/ssh/gateway.js`), which passes only the API and the WebSocket through the SSH connection. The UI's code never comes from the server.

Project code runs with the project's own environment on the server (`.venv`, or the interpreter chosen in Environment), else the server's `python3`, exactly as on a computer.

## Requirements

- A Linux or macOS server with SSH and a POSIX shell (Windows servers aren't supported).
- The first time: internet access from the server to PyPI (and to GitHub if Tandem must install its own Python).
- Your account on the server: Tandem installs nothing outside `~/.tandem`.

## Sign-in and what's kept

- **Password or SSH key** (ed25519, ECDSA or RSA, with or without a passphrase).
- Saved servers (address, port, username, folder, key file path) are kept in the app's data, without secrets. A password or passphrase is kept only when you tick **Remember**, encrypted by the operating system (Windows DPAPI, macOS Keychain).
- Passwords, keys and passphrases are typed in the app's own connect window, never in the Tandem page.
- Known servers' host keys: `ssh-known-hosts.json` in the app's data.

## Not on servers (yet)

- **The assistant**: AI keys stay on this device and are never stored on a server.
- **Shared projects (Cowork)** stay a this-device feature.

## iPad

Coming in the next step: the same connection from the iPad app (SwiftNIO SSH), with the same gateway in the app's local server.

## Tests

- `runtime/tests/test_remote_flags.py`: the runtime's server flags (`--print-token`, `--exit-with-stdin`, `--no-ui`).
- `desktop/ssh/ssh.test.cjs`: connection details, host key fingerprints, known hosts, and the gateway (the server's Host and Origin, what stays on this device).
- `packaging/ssh-e2e.cjs`: the desktop app against a real `sshd` (CI: the macOS runner, with a packaged app; the server's Python is 3.9 there, so Tandem installs its own): host key confirmation, install, Run, Step through, a notebook cell, the Terminal, Disconnect (Tandem stops on the server), a key sign-in, and a changed host key refused.
