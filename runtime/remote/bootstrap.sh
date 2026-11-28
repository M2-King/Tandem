#!/bin/sh
# Tandem on an SSH server. The Tandem apps (desktop and iPad) send this
# script over SSH and run it there; nothing here runs on the person's own
# device.
#
#   sh bootstrap.sh check   <id>            what this server has
#   sh bootstrap.sh install <id>            the full tools, in ~/.tandem/remote/<id>
#   sh bootstrap.sh serve   <id> <folder>   start Tandem there (folder in base64)
#
# <id> names one version of these files (a hash the app computes); the app
# uploads them into ~/.tandem/remote/<id>/ first.
#
# Without installing anything, `serve` starts lite.py with the server's own
# python3 (3.6 or newer, standard library only): the project's files, the
# Terminal and Run. Nothing is downloaded. After `install` (when the person
# asks for notebooks and the debugger), it starts Tandem's full runtime.
#
# The full runtime's own Python, quickest first:
#   1. the server's Python 3.9 or newer, in a venv with its own pip;
#   2. the same without ensurepip (Debian and Ubuntu without python3-venv):
#      a venv without pip, and a pinned pip wheel (1.8 MB) to install with;
#   3. no Python 3.9 or newer: a standalone Python 3.12 installed with uv (a
#      pinned uv wheel, about 17 MB, and Python from GitHub, about 30 MB).
# Downloads come from the fastest of PyPI and its mirrors in mainland China
# (where PyPI is often slow), unless the server's pip.conf names an index;
# Python for uv from the fastest of its usual sources and npmmirror. Every
# file is checked against its sha256 (packages: constraints.txt, installed
# with --require-hashes; uv and pip: here; Python: by uv), so a mirror can
# only serve the genuine files. Project code doesn't use this Python: it runs
# with the project's own environment, as on a computer.
#
# While installing, "tandem-step" lines say what's happening every couple of
# seconds (how much is downloaded, how long it has taken); a download that
# stalls stops with a message instead of waiting forever.
#
# `serve` starts the runtime on the server's 127.0.0.1 only, with a new
# random token, and it stops when the SSH connection that started it closes.
# Output lines the app reads start with "tandem-".

set -u

UV_VERSION=0.13.7
PIP_VERSION=26.0.1
PIP_FILE=pip-26.0.1-py3-none-any.whl
PIP_URL=https://files.pythonhosted.org/packages/de/f0/c81e05b613866b76d2d1066490adf1a3dbc4ee9d9c839961c3fc8a6997af/pip-26.0.1-py3-none-any.whl
PIP_SUM=bdb1b08f4274833d62c1aa29e20907365a2ceb950410df15fc9521bad440122b
PIP_SIZE=1787723
PYPI=https://pypi.org/simple
# Package indexes when the server has none set up: PyPI and mirrors in
# mainland China. The fastest to answer is used.
INDEXES="$PYPI https://mirrors.aliyun.com/pypi/simple https://pypi.tuna.tsinghua.edu.cn/simple https://mirrors.cloud.tencent.com/pypi/simple https://repo.huaweicloud.com/repository/pypi/simple"
# Where uv gets Python: its default (releases.astral.sh, then GitHub), or
# npmmirror's copy of the same releases.
PYTHON_SOURCES="https://releases.astral.sh/github/python-build-standalone/releases/download https://github.com/astral-sh/python-build-standalone/releases/download https://registry.npmmirror.com/-/binary/python-build-standalone"

cmd=${1:-}
id=${2:-}
case "$id" in
  '' | *[!0-9a-f]*) printf 'tandem-error %s\n' "Bad install id."; exit 2 ;;
esac
base="$HOME/.tandem/remote"
dir="$base/$id"
log="$dir/install.log"

say() { printf '%s\n' "$*" 2>/dev/null; }
fail() { say "tandem-error $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- Python

# The newest Python 3.9 or newer with venv: in PATH, or where Pythons are
# often installed but not in PATH for SSH commands (conda, pyenv, Homebrew).
# TANDEM_REMOTE_PYTHON: use this one only. TANDEM_REMOTE_USE_UV=1: ignore the
# server's Pythons (tests; a broken system Python).
find_python() {
  [ "${TANDEM_REMOTE_USE_UV:-}" = 1 ] && return 1
  newest_python 'import sys, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)'
}

# Any python3 3.6 or newer, for lite.py (standard library only).
find_any_python() {
  newest_python 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)'
}

# The newest Python for which the check ($1, Python code) passes.
newest_python() {
  if [ -n "${TANDEM_REMOTE_PYTHON:-}" ]; then
    "$TANDEM_REMOTE_PYTHON" -c "$1" >/dev/null 2>&1 && { say "$TANDEM_REMOTE_PYTHON"; return 0; }
    return 1
  fi
  dirs=$(printf '%s' "${PATH:-}" | tr ':' ' ')
  for name in python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python3.7 python3.6 python3; do
    for d in $dirs /usr/local/bin /opt/homebrew/bin /usr/bin "$HOME/.local/bin" "$HOME/.pyenv/shims" \
      "$HOME/miniforge3/bin" "$HOME/miniconda3/bin" "$HOME/anaconda3/bin" /opt/conda/bin /opt/miniconda3/bin /opt/anaconda3/bin; do
      [ -x "$d/$name" ] || continue
      "$d/$name" -c "$1" >/dev/null 2>&1 && { say "$d/$name"; return 0; }
    done
  done
  return 1
}

# ---------------------------------------------------------------- progress

# Tenths of a megabyte: 3.2
mb() { t=$((${1:-0} * 10 / 1048576)); printf '%d.%d' $((t / 10)) $((t % 10)); }
clock() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }
bytes_in() {
  if [ -d "$1" ]; then k=$(du -sk "$1" 2>/dev/null | cut -f1); printf '%s' $((${k:-0} * 1024))
  elif [ -f "$1" ]; then wc -c < "$1" | tr -d ' '
  else printf 0
  fi
}

# Runs "$@" (its output goes to the install log) and says every 2 seconds
# how far it has got: the size of $2 (a file or folder it writes), out of $3
# bytes when that's known, or with the time taken. Its exit status.
with_progress() {
  wp_label=$1 wp_watch=$2 wp_total=$3
  shift 3
  say "tandem-step $wp_label"
  "$@" >> "$log" 2>&1 &
  wp_pid=$!
  wp_start=$(date +%s)
  wp_n=0
  while kill -0 "$wp_pid" 2>/dev/null; do
    sleep 1
    wp_n=$((wp_n + 1))
    [ $((wp_n % 2)) = 0 ] || continue
    kill -0 "$wp_pid" 2>/dev/null || break
    wp_got=$(bytes_in "$wp_watch")
    wp_secs=$(($(date +%s) - wp_start))
    if [ -n "$wp_total" ]; then say "tandem-step $wp_label ($(mb "$wp_got") of $(mb "$wp_total") MB)"
    elif [ "$wp_got" -gt 1048576 ]; then say "tandem-step $wp_label ($(mb "$wp_got") MB, $(clock "$wp_secs"))"
    else say "tandem-step $wp_label ($(clock "$wp_secs"))"
    fi
  done
  wait "$wp_pid"
}

# ---------------------------------------------------------------- downloads

# A download that gives up when it stalls (under 1 KB/s for a minute) rather
# than waiting forever. With curl, wget, or the Python found.
download() {
  if have curl; then curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 2 --retry-delay 3 -o "$2" "$1"
  elif have wget; then wget -q -T 30 -t 3 -O "$2" "$1"
  elif [ -n "${py:-}" ]; then
    "$py" -c 'import shutil, sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=30) as r, open(sys.argv[2], "wb") as f: shutil.copyfileobj(r, f)' "$1" "$2"
  else return 1
  fi
}

# Whether the server at a URL answers (with any HTTP status) within 20
# seconds, asking twice (a connection can drop once). Unknown (no tool to
# ask): yes.
answers() {
  answers_once "$1" || answers_once "$1"
}

answers_once() {
  if have curl; then
    code=$(curl -sS -o /dev/null --max-time 20 -w '%{http_code}' "$1" 2>/dev/null)
    [ "${code:-000}" != 000 ]
  elif have wget; then
    wget -q -T 20 -t 1 -O /dev/null "$1" 2>/dev/null
    rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 8 ]
  elif [ -n "${py:-}" ]; then
    "$py" -c 'import sys, urllib.error, urllib.request
try: urllib.request.urlopen(sys.argv[1], timeout=20)
except urllib.error.HTTPError: pass' "$1" 2>/dev/null
  else return 0
  fi
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif [ -n "${py:-}" ]; then "$py" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
  else return 1
  fi
}

# The package index this server's pip is set up to use (often a mirror where
# PyPI is slow), else PyPI.
package_index() {
  if [ -n "${PIP_INDEX_URL:-}" ]; then printf '%s' "$PIP_INDEX_URL"; return; fi
  for f in "${PIP_CONFIG_FILE:-}" "$HOME/.config/pip/pip.conf" "$HOME/.pip/pip.conf" /etc/pip.conf /etc/xdg/pip/pip.conf; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    u=$(sed -n 's/^[[:space:]]*index[-_]url[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p' "$f" | head -n 1)
    [ -n "$u" ] && { printf '%s' "$u"; return; }
  done
  printf '%s' "$PYPI"
}

# A proxy set for pip only (pip.conf), which a reachability check can't use.
pip_proxy() {
  for f in "${PIP_CONFIG_FILE:-}" "$HOME/.config/pip/pip.conf" "$HOME/.pip/pip.conf" /etc/pip.conf /etc/xdg/pip/pip.conf; do
    [ -n "$f" ] && [ -f "$f" ] && grep -q '^[[:space:]]*proxy[[:space:]]*=' "$f" && return 0
  done
  return 1
}

host_of() { printf '%s' "$1" | sed 's#^[a-z]*://\([^/:@]*@\)\{0,1\}\([^/:]*\).*#\2#'; }

# Seconds a URL takes to send its first 256 KB (or all of it, if smaller);
# fails if it doesn't answer with success within 10 seconds.
probe_time() {
  if have curl; then
    curl -fsSL -o /dev/null -r 0-262143 --max-time 10 -w '%{time_total}' "$1" 2>/dev/null
  elif [ -n "${py:-}" ] || have python3; then
    "${py:-python3}" -c 'import sys, time, urllib.request
t = time.time()
with urllib.request.urlopen(urllib.request.Request(sys.argv[1], headers={"Range": "bytes=0-262143"}), timeout=10) as r:
    n = 0
    while n < 262144 and time.time() - t < 10:
        b = r.read(65536)
        if not b:
            break
        n += len(b)
if time.time() - t >= 10:
    sys.exit(1)
print("%.3f" % (time.time() - t))' "$1" 2>/dev/null
  else return 1
  fi
}

# fastest <path> <base URL>...: the base that serves <base><path> quickest,
# all tried at once.
fastest() {
  ff_path=$1
  shift
  ff_dir="$base/.probe.$$"
  rm -rf "$ff_dir"
  mkdir -p "$ff_dir" || return 1
  ff_n=0
  for ff_base in "$@"; do
    ff_n=$((ff_n + 1))
    (t=$(probe_time "$ff_base$ff_path") && [ -n "$t" ] && printf '%s %s\n' "$t" "$ff_base" > "$ff_dir/$ff_n") &
  done
  wait
  ff_best=$(cat "$ff_dir"/* 2>/dev/null | LC_ALL=C sort -n | head -n 1 | cut -d' ' -f2)
  rm -rf "$ff_dir"
  [ -n "$ff_best" ] && printf '%s' "$ff_best"
}

# Sets $index: the index the server's pip is set up with (or
# TANDEM_REMOTE_INDEX), checked to answer within 20 seconds; else the fastest
# of PyPI and its mirrors. Fails within seconds, saying why, when none can be
# reached, instead of each download waiting for its own timeout.
choose_index() {
  index=${TANDEM_REMOTE_INDEX:-$(package_index)}
  if [ -n "${TANDEM_REMOTE_INDEX:-}" ] || [ "$index" != "$PYPI" ]; then
    say "tandem-step Checking the server can reach $(host_of "$index")"
    pip_proxy || answers "${index%/}/pip/" ||
      fail "This server couldn't reach $(host_of "$index") (the package index the server is set up to use) within 20 seconds, so Tandem can't install its tools there. Check the server's internet access, then connect again. The Terminal, files and Run work without them: connect again without \"Also install notebooks and the debugger\"."
    return 0
  fi
  pip_proxy && return 0
  say "tandem-step Finding the fastest package source (PyPI or a mirror in China)"
  index=$(fastest /pip/ $INDEXES) ||
    fail "This server couldn't reach PyPI or its mirrors (Aliyun, Tsinghua, Tencent, Huawei) within 10 seconds, so Tandem can't install its tools there. Check the server's internet access, then connect again. The Terminal, files and Run work without them: connect again without \"Also install notebooks and the debugger\"."
  say "tandem-step Packages from $(host_of "$index")"
}

# Where the index has file $2 of project $1 (PyPI: its own URL, $3).
index_file_url() {
  case "$index" in "$PYPI" | "$PYPI/" | https://pypi.python.org/simple*) printf '%s' "$3"; return 0 ;; esac
  page="$base/.index.$$"
  download "${index%/}/$1/" "$page" 2>/dev/null || { rm -f "$page"; return 1; }
  href=$(tr '<' '\n' < "$page" | grep -F "$2" | sed -n 's/.*href="\([^"]*\)".*/\1/p' | head -n 1)
  rm -f "$page"
  href=${href%%#*}
  [ -n "$href" ] || return 1
  case "$href" in
    http://* | https://*) printf '%s' "$href" ;;
    /*) printf '%s%s' "$(printf '%s' "$index" | sed 's#^\([a-z]*://[^/]*\).*#\1#')" "$href" ;;
    *) printf '%s/%s/%s' "${index%/}" "$1" "$href" ;;
  esac
}

# A pinned wheel, from the server's index and else PyPI, checked against its
# sha256. fetch_wheel project file pypi-url sha256 size label destination
fetch_wheel() {
  fw_tmp="$7.$$"
  fw_urls=$3
  if fw_mirror=$(index_file_url "$1" "$2" "$3") && [ "$fw_mirror" != "$3" ]; then fw_urls="$fw_mirror $3"; fi
  for fw_url in $fw_urls; do
    rm -f "$fw_tmp"
    with_progress "$6" "$fw_tmp" "$5" download "$fw_url" "$fw_tmp" || continue
    fw_got=$(sha256_of "$fw_tmp") || fail "Neither sha256sum nor shasum is available to check the download."
    [ "$fw_got" = "$4" ] && { mv "$fw_tmp" "$7"; return 0; }
    say "tandem-step The download from $fw_url didn't match its checksum, so it wasn't used"
  done
  rm -f "$fw_tmp"
  return 1
}

# uv, from its wheel for this system; sets $uv.
get_uv() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Linux/x86_64)
      file=uv-0.13.7-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
      url=https://files.pythonhosted.org/packages/b9/93/0e053a2ca4523ee9825ccbedeb7121470d0a188933f11688b6d90d7f5c08/$file
      sum=2c9bdc4a872b60a93c5f26c0791089ea11585a4f9d3b3c017d78eb8487505e25 size=17202345 ;;
    Linux/aarch64 | Linux/arm64)
      file=uv-0.13.7-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
      url=https://files.pythonhosted.org/packages/96/72/da1119f94034d7173e6c8e2cd77a6299744458f0af3cb8e3a04d5cd419d1/$file
      sum=a90f5d95716ab83091f0f73a8e7ec64e557abf2a28537fcd719b2ac88e6f725a size=17656749 ;;
    Darwin/arm64)
      file=uv-0.13.7-py3-none-macosx_11_0_arm64.whl
      url=https://files.pythonhosted.org/packages/40/a5/8756c38ace102fa13fd4e653e8bc40e1f65924f1c0a0d23350339dac97e5/$file
      sum=f91a229093163eefca89ea1b220a221d64c3beade05d03519a6584d1797a5a5f size=14454941 ;;
    Darwin/x86_64)
      file=uv-0.13.7-py3-none-macosx_10_12_x86_64.whl
      url=https://files.pythonhosted.org/packages/3d/5b/e0379e7b172659420b1ec99a8e8229830aa85ea59684847c80b1c959a056/$file
      sum=fd04bf01ba5f2829f4f94ca8f0c24a743f21e73d75045613ed6fc2fd66fc7bda size=17194673 ;;
    *) fail "This server ($os $arch) has no Python 3.9 or newer, and Tandem can't install one for it. Install python3 (3.9 or newer, with venv) on the server, then connect again." ;;
  esac
  uvdir="$base/uv-$UV_VERSION"
  uv="$uvdir/uv"
  [ -x "$uv" ] && return 0
  mkdir -p "$uvdir" || fail "Couldn't create $uvdir."
  fetch_wheel uv "$file" "$url" "$sum" "$size" "Downloading uv to install Python for Tandem" "$uvdir/uv.whl" \
    || fail "This server has no Python 3.9 or newer, and couldn't download uv (about 17 MB) from $(printf '%s' "$index" | sed 's#^[a-z]*://\([^/]*\).*#\1#') to install one. Install python3 (3.9 or newer, with venv) on the server, or check its internet access, then connect again."
  member="uv-$UV_VERSION.data/scripts/uv"
  if have unzip; then
    unzip -p "$uvdir/uv.whl" "$member" > "$uvdir/uv.$$" || fail "Couldn't unpack uv."
  elif have python3; then
    python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$uvdir/uv.whl" "$member" > "$uvdir/uv.$$" || fail "Couldn't unpack uv."
  else
    fail "Neither unzip nor python3 is available to unpack uv."
  fi
  chmod +x "$uvdir/uv.$$" && mv "$uvdir/uv.$$" "$uv" && rm -f "$uvdir/uv.whl"
}

decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null
}

# ---------------------------------------------------------------- commands

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
    # If the app's connection drops, the install carries on (the next
    # connection finds it done, or waits for it): progress written to a
    # closed connection mustn't stop it.
    trap '' PIPE HUP

    # One install at a time (two windows connecting at once). A lock left by
    # an install that stopped (its process is gone) is taken over.
    lock="$dir/.lock"
    start=$(date +%s)
    until mkdir "$lock" 2>/dev/null; do
      [ -f "$dir/ok" ] && { say tandem-installed; exit 0; }
      holder=$(cat "$lock/pid" 2>/dev/null)
      if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } ||
        { [ -z "$holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; }; then
        rm -rf "$lock"
        continue
      fi
      waited=$(($(date +%s) - start))
      [ "$waited" -gt 1800 ] && fail "Another Tandem install on this server didn't finish in 30 minutes. See $log."
      say "tandem-step Waiting for the Tandem install already under way on this server ($(clock "$waited"))"
      sleep 2
    done
    echo $$ > "$lock/pid"
    trap 'rm -rf "$lock"' EXIT
    trap 'exit 1' INT TERM
    [ -f "$dir/ok" ] && { say tandem-installed; exit 0; }

    : > "$log"
    rm -rf "$dir/venv"
    pip_flags="--disable-pip-version-check --no-input --timeout 30 --retries 2"
    py=$(find_python) || py=

    if [ -n "$py" ] && "$py" -m venv "$dir/venv" >> "$log" 2>&1; then
      # 1. The server's Python, with its own pip.
      choose_index
      with_progress "Installing Tandem's packages with $("$py" -c 'import sys; print("Python %d.%d" % sys.version_info[:2])' 2>/dev/null)" "$dir/venv" "" \
        "$dir/venv/bin/python" -m pip install $pip_flags --index-url "$index" --require-hashes -r "$dir/constraints.txt" \
        || fail "Installing Tandem's packages failed (no internet on the server, or its package index unreachable?). Details: $log"
    elif [ -n "$py" ] && { rm -rf "$dir/venv"; "$py" -m venv --without-pip "$dir/venv" >> "$log" 2>&1; }; then
      # 2. The server's Python without ensurepip: pip from a pinned wheel.
      choose_index
      pipwhl="$base/$PIP_FILE"
      [ -f "$pipwhl" ] || fetch_wheel pip "$PIP_FILE" "$PIP_URL" "$PIP_SUM" "$PIP_SIZE" "Downloading pip" "$pipwhl" \
        || fail "Couldn't download pip (1.8 MB) for the server's Python. Install python3-venv (or python3-pip) on the server, or check its internet access, then connect again."
      with_progress "Installing Tandem's packages with $("$py" -c 'import sys; print("Python %d.%d" % sys.version_info[:2])' 2>/dev/null)" "$dir/venv" "" \
        "$dir/venv/bin/python" "$pipwhl/pip" install $pip_flags --index-url "$index" --require-hashes -r "$dir/constraints.txt" \
        || fail "Installing Tandem's packages failed (no internet on the server, or its package index unreachable?). Details: $log"
    else
      # 3. No usable Python: uv, and Python 3.12 for Tandem.
      rm -rf "$dir/venv"
      choose_index
      get_uv
      export UV_HTTP_TIMEOUT=60
      if [ -n "$py" ]; then
        with_progress "Setting up Tandem's Python environment" "$dir/venv" "" \
          "$uv" venv --quiet --python "$py" "$dir/venv" \
          || fail "Couldn't create a Python environment with $py. Details: $log"
      else
        # The fastest source of the build uv would download (uv checks its sha256).
        if [ -z "${UV_PYTHON_INSTALL_MIRROR:-}" ]; then
          say "tandem-step Finding the fastest source for Python 3.12"
          build=$("$uv" python list 3.12 --only-downloads --output-format json 2>/dev/null |
            grep -o '"url": *"[^"]*python-build-standalone/releases/download/[^"]*"' | head -n 1 |
            sed 's#.*/releases/download/##; s#"$##')
          if [ -n "$build" ]; then
            source=$(fastest "/$build" $PYTHON_SOURCES) ||
              fail "This server has no Python 3.9 or newer, and couldn't reach GitHub or its mirror (npmmirror) within 10 seconds to get one for Tandem. Install python3 (3.9 or newer, with venv) on the server, then connect again."
            case "$source" in https://releases.astral.sh/*) ;; *) export UV_PYTHON_INSTALL_MIRROR="$source" ;; esac
            say "tandem-step Python from $(host_of "$source")"
          fi
        fi
        UV_PYTHON_INSTALL_DIR="$base/python" with_progress "Downloading Python 3.12 for Tandem" "$base/python" "" \
          "$uv" venv --quiet --python 3.12 --python-preference only-managed "$dir/venv" \
          || fail "Couldn't install Python 3.12 for Tandem (no internet on the server?). Details: $log"
      fi
      with_progress "Installing Tandem's packages" "$dir/venv" "" \
        "$uv" pip install --quiet --python "$dir/venv/bin/python" --index-url "$index" --require-hashes -r "$dir/constraints.txt" \
        || fail "Installing Tandem's packages failed (no internet on the server, or its package index unreachable?). Details: $log"
    fi
    # The runtime itself, uploaded by the app (its packages are all in place).
    if [ -x "$dir/venv/bin/pip" ] || "$dir/venv/bin/python" -m pip --version >/dev/null 2>&1; then
      "$dir/venv/bin/python" -m pip install $pip_flags --no-deps --no-index "$wheel" >> "$log" 2>&1
    elif [ -n "${pipwhl:-}" ]; then
      "$dir/venv/bin/python" "$pipwhl/pip" install $pip_flags --no-deps --no-index "$wheel" >> "$log" 2>&1
    else
      "$uv" pip install --quiet --python "$dir/venv/bin/python" --no-deps --no-index "$wheel" >> "$log" 2>&1
    fi || fail "Couldn't install Tandem's runtime on the server. Details: $log"
    "$dir/venv/bin/tandem" --help > /dev/null 2>&1 || fail "Tandem was installed but doesn't start (see $log)."
    touch "$dir/ok"
    say tandem-installed
    ;;

  serve)
    folder=$(decode "${3:-}") || fail "Bad folder name."
    case "$folder" in
      '' | '~') folder=$HOME ;;
      '~/'*) folder="$HOME/${folder#\~/}" ;;
    esac
    [ -d "$folder" ] || fail "There's no folder $folder on this server."
    if [ -f "$dir/ok" ]; then
      exec "$dir/venv/bin/tandem" serve "$folder" --port 0 --print-url --print-token --exit-with-stdin --no-ui
    fi
    # Nothing installed: files, the Terminal and Run with the server's python3.
    [ -f "$dir/lite.py" ] || fail "Tandem's files weren't uploaded to the server."
    lite_py=$(find_any_python) ||
      fail "This server has no python3 (3.6 or newer), which Tandem needs to show its files, open the Terminal and run code. Install python3 on the server, then connect again."
    exec "$lite_py" "$dir/lite.py" "$folder"
    ;;

  *)
    fail "Unknown command."
    ;;
esac
