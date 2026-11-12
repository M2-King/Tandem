"""Finding the project's Python on macOS (interpreters._mac_python)."""

import os
import sys

import pytest

from tandem_runtime import interpreters

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="fake interpreters are shell scripts")


def fake_python(directory, name, version):
    directory.mkdir(parents=True, exist_ok=True)
    exe = directory / name
    exe.write_text(f"#!/bin/sh\necho '{version}'\n")
    exe.chmod(0o755)
    return exe


def test_takes_the_first_python_311_or_newer(tmp_path):
    old = fake_python(tmp_path / "path", "python3", "3 9")
    brew = fake_python(tmp_path / "brew", "python3", "3 12")
    later = fake_python(tmp_path / "pyorg", "python3", "3 13")
    found = interpreters._mac_python(path_env=str(old.parent), places=(str(brew.parent), str(later.parent)), framework=None)
    assert found == str(brew)


def test_falls_back_to_an_older_python_3_when_nothing_newer(tmp_path):
    old = fake_python(tmp_path / "path", "python3", "3 10")
    assert interpreters._mac_python(path_env=str(old.parent), places=(), framework=None) == str(old)


def test_versioned_names_are_found(tmp_path):
    exe = fake_python(tmp_path / "brew", "python3.12", "3 12")
    assert interpreters._mac_python(path_env="", places=(str(exe.parent),), framework=None) == str(exe)


def test_never_tries_apples_usr_bin_python(tmp_path):
    assert all(not str(p).startswith("/usr/bin/") for p in interpreters.mac_candidates(path_env="/usr/bin", places=(), framework=None))


def test_nothing_found(tmp_path):
    assert interpreters._mac_python(path_env=str(tmp_path), places=(), framework=None) is None


def test_python_org_versions_are_found(tmp_path):
    exe = fake_python(tmp_path / "Versions" / "3.13" / "bin", "python3", "3 13")
    assert interpreters._mac_python(path_env="", places=(), framework=tmp_path / "Versions") == str(exe)


def test_child_env_adds_the_usual_places_on_macos(tmp_path, monkeypatch):
    monkeypatch.setattr(interpreters.sys, "platform", "darwin")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    env = interpreters.child_env(tmp_path / "bin" / "python3", {})
    parts = env["PATH"].split(os.pathsep)
    assert parts[0] == str(tmp_path / "bin")
    assert "/opt/homebrew/bin" in parts and parts[-2:] == ["/usr/bin", "/bin"]
