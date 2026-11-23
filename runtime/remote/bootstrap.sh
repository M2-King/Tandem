#!/bin/sh
# Tandem on an SSH server: installs Tandem's runtime in the SSH user's home
# folder and starts it for one project folder. The Tandem apps (desktop and
# iPad) send this script over SSH and run it there; nothing here runs on the
# person's own device.
#
#   sh bootstrap.sh check   <id>            what this server has
#   sh bootstrap.sh install <id>            set up ~/.tandem/remote/<id>
#   sh bootstrap.sh serve   <id> <folder>   start the runtime (folder in base64)
#
# <id> names one version of the runtime (a hash the app computes). The app
# uploads the runtime wheel and constraints.txt into ~/.tandem/remote/<id>/
# before `install`. The runtime's own Python: the server's python3 if it is
# 3.11 or newer (with venv), else a standalone Python 3.12 installed with uv
# (a pinned release from PyPI, checked against its sha256). The runtime's
# packages come from PyPI, pinned by constraints.txt. Project code doesn't
# use this Python: it runs with the project's own environment, as on a
# computer.
#
# `serve` starts the runtime on the server's 127.0.0.1 only, with a new
# random token, and it stops when the SSH connection that started it closes.
# Output lines the app reads start with "tandem-".

set -u

UV_VERSION=0.13.7
cmd=${1:-}
id=${2:-}
case "$id" in
  '' | *[!0-9a-f]*) printf 'tandem-error %s\n' "Bad install id."; exit 2 ;;
esac
base="$HOME/.tandem/remote"
dir="$base/$id"

say() { printf '%s\n' "$*"; }
fail() { say "tandem-error $*"; exit 1; }

# A python3 that is 3.11 or newer and can make a venv with pip.
find_python() {
  # TANDEM_REMOTE_USE_UV=1: ignore the server's Python (tests; a broken system Python).
  [ "${TANDEM_REMOTE_USE_UV:-}" = 1 ] && return 1
  for name in python3.13 python3.12 python3.11 python3; do
    p=$(command -v "$name" 2>/dev/null) || continue
    if "$p" -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      say "$p"
      return 0
    fi
  done
  return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else return 1
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else return 1
  fi
}

# uv, from its PyPI wheel for this system, checked against the wheel's sha256.
get_uv() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Linux/x86_64)
      url=https://files.pythonhosted.org/packages/b9/93/0e053a2ca4523ee9825ccbedeb7121470d0a188933f11688b6d90d7f5c08/uv-0.13.7-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
      sum=2c9bdc4a872b60a93c5f26c0791089ea11585a4f9d3b3c017d78eb8487505e25 ;;
    Linux/aarch64 | Linux/arm64)
      url=https://files.pythonhosted.org/packages/96/72/da1119f94034d7173e6c8e2cd77a6299744458f0af3cb8e3a04d5cd419d1/uv-0.13.7-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
      sum=a90f5d95716ab83091f0f73a8e7ec64e557abf2a28537fcd719b2ac88e6f725a ;;
    Darwin/arm64)
      url=https://files.pythonhosted.org/packages/40/a5/8756c38ace102fa13fd4e653e8bc40e1f65924f1c0a0d23350339dac97e5/uv-0.13.7-py3-none-macosx_11_0_arm64.whl
      sum=f91a229093163eefca89ea1b220a221d64c3beade05d03519a6584d1797a5a5f ;;
    Darwin/x86_64)
      url=https://files.pythonhosted.org/packages/3d/5b/e0379e7b172659420b1ec99a8e8229830aa85ea59684847c80b1c959a056/uv-0.13.7-py3-none-macosx_10_12_x86_64.whl
      sum=fd04bf01ba5f2829f4f94ca8f0c24a743f21e73d75045613ed6fc2fd66fc7bda ;;
    *) fail "This server ($os $arch) has no Python 3.11 or newer, and Tandem can't install one for it. Install python3.11 (or newer, with venv) on the server, then connect again." ;;
  esac
  uvdir="$base/uv-$UV_VERSION"
  if [ -x "$uvdir/uv" ]; then say "$uvdir/uv"; return 0; fi
  mkdir -p "$uvdir" || fail "Couldn't create $uvdir."
  download "$url" "$uvdir/uv.whl" || fail "This server has no Python 3.11 or newer, and couldn't download uv from PyPI to install one (no internet, or neither curl nor wget). Install python3.11 (or newer, with venv) on the server, then connect again."
  got=$(sha256_of "$uvdir/uv.whl") || fail "Neither sha256sum nor shasum is available to check the download."
  [ "$got" = "$sum" ] || { rm -f "$uvdir/uv.whl"; fail "The uv download didn't match its checksum, so it wasn't used."; }
  member="uv-$UV_VERSION.data/scripts/uv"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$uvdir/uv.whl" "$member" > "$uvdir/uv.tmp" || fail "Couldn't unpack uv."
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$uvdir/uv.whl" "$member" > "$uvdir/uv.tmp" || fail "Couldn't unpack uv."
  else
    fail "Neither unzip nor python3 is available to unpack uv."
  fi
  chmod +x "$uvdir/uv.tmp" && mv "$uvdir/uv.tmp" "$uvdir/uv" && rm -f "$uvdir/uv.whl"
  say "$uvdir/uv"
}

decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null
}

case "$cmd" in
  check)
    if [ -f "$dir/ok" ]; then installed=1; else installed=0; fi
    python=$(find_python) || python=none
    say "tandem-check os=$(uname -s) arch=$(uname -m) installed=$installed python=$python"
    ;;

  install)
    case "$(uname -s)" in
      Linux | Darwin) ;;
      *) fail "Tandem runs projects on Linux and macOS servers." ;;
    esac
    wheel=$(ls "$dir"/tandem_runtime-*.whl 2>/dev/null | head -n 1)
    [ -n "$wheel" ] || fail "The runtime wasn't uploaded."
    [ -f "$dir/constraints.txt" ] || fail "The runtime's constraints weren't uploaded."
    # One install at a time (two windows connecting at once).
    lock="$dir/.lock"
    waited=0
    until mkdir "$lock" 2>/dev/null; do
      [ -f "$dir/ok" ] && { say tandem-installed; exit 0; }
      waited=$((waited + 1))
      [ "$waited" -gt 600 ] && fail "Another install on this server didn't finish."
      sleep 1
    done
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    [ -f "$dir/ok" ] && { say tandem-installed; exit 0; }
    log="$dir/install.log"
    : > "$log"
    rm -rf "$dir/venv"
    if py=$(find_python); then
      say "tandem-step Creating Tandem's Python environment ($py)"
      "$py" -m venv "$dir/venv" >> "$log" 2>&1 || fail "Couldn't create a Python environment with $py (see $log)."
      say "tandem-step Installing Tandem's packages from PyPI (the first time takes a minute)"
      "$dir/venv/bin/python" -m pip install --disable-pip-version-check --no-input -c "$dir/constraints.txt" "$wheel" >> "$log" 2>&1 \
        || fail "Installing Tandem's packages failed (no internet on the server, or PyPI unreachable?). Details: $log"
    else
      say "tandem-step Getting uv to install Python 3.12 for Tandem"
      uv=$(get_uv) || { say "$uv"; exit 1; }
      say "tandem-step Installing Python 3.12 for Tandem (the first time takes a minute)"
      UV_PYTHON_INSTALL_DIR="$base/python" "$uv" venv --quiet --python 3.12 --python-preference only-managed "$dir/venv" >> "$log" 2>&1 \
        || fail "Couldn't install Python 3.12 for Tandem (no internet on the server?). Details: $log"
      say "tandem-step Installing Tandem's packages from PyPI"
      "$uv" pip install --quiet --python "$dir/venv/bin/python" -c "$dir/constraints.txt" "$wheel" >> "$log" 2>&1 \
        || fail "Installing Tandem's packages failed (no internet on the server, or PyPI unreachable?). Details: $log"
    fi
    "$dir/venv/bin/tandem" --help > /dev/null 2>&1 || fail "Tandem was installed but doesn't start (see $log)."
    touch "$dir/ok"
    say tandem-installed
    ;;

  serve)
    [ -f "$dir/ok" ] || fail "Tandem isn't installed on this server yet."
    folder=$(decode "${3:-}") || fail "Bad folder name."
    case "$folder" in
      '' | '~') folder=$HOME ;;
      '~/'*) folder="$HOME/${folder#\~/}" ;;
    esac
    [ -d "$folder" ] || fail "There's no folder $folder on this server."
    exec "$dir/venv/bin/tandem" serve "$folder" --port 0 --print-url --print-token --exit-with-stdin --no-ui
    ;;

  *)
    fail "Unknown command."
    ;;
esac
