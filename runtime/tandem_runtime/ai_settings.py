"""AI provider settings: which provider and model, and the API keys.

Keys are stored only by this local runtime, in a file readable by the
current user alone (0600 on macOS/Linux; on Windows the per-user AppData
folder). They are never sent back to the browser (the UI only learns that a
key is saved and its last four characters), never passed to project code, and
never logged.

Settings live in the user's config folder, not in the project, so a key can't
be committed to git by accident:
  Windows  %APPDATA%\\Tandem\\
  macOS    ~/Library/Application Support/Tandem/
  Linux    $XDG_CONFIG_HOME/tandem/ (default ~/.config/tandem/)
TANDEM_CONFIG_DIR overrides the folder (used by the tests).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROVIDERS = {
    "anthropic": {"label": "Anthropic", "needs_key": True, "base_url": "https://api.anthropic.com",
                  "model": "claude-opus-5-5"},
    "openai": {"label": "OpenAI-compatible", "needs_key": True, "base_url": "https://api.openai.com/v1",
               "model": ""},
    "ollama": {"label": "Ollama (local)", "needs_key": False, "base_url": "http://127.0.0.1:11434",
               "model": ""},
}
MAX_KEY_LENGTH = 512
MAX_FIELD_LENGTH = 300


class SettingsError(Exception):
    """A rejected change; the message is safe to show."""


def config_dir() -> Path:
    override = os.environ.get("TANDEM_CONFIG_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Tandem"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Tandem"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "tandem"


def _write_private(path: Path, data: dict) -> None:
    """Atomic write, readable by the current user only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class AISettings:
    def __init__(self, folder: Path | None = None):
        self.folder = folder or config_dir()

    @property
    def _config_path(self) -> Path:
        return self.folder / "ai.json"

    @property
    def _secrets_path(self) -> Path:
        return self.folder / "secrets.json"

    def _config(self) -> dict:
        return _read(self._config_path)

    def _keys(self) -> dict:
        return _read(self._secrets_path).get("api_keys", {})

    def key(self, provider: str) -> str | None:
        """The stored key (runtime-internal use only: never return this to the UI)."""
        return self._keys().get(provider) or None

    def provider_config(self, provider: str) -> dict:
        defaults = PROVIDERS[provider]
        saved = self._config().get("providers", {}).get(provider, {})
        return {"base_url": saved.get("base_url") or defaults["base_url"], "model": saved.get("model", defaults["model"])}

    def public(self) -> dict:
        """What the UI may see: no key values, only whether one is saved."""
        keys = self._keys()
        providers = {}
        for name, meta in PROVIDERS.items():
            key = keys.get(name)
            providers[name] = {
                "label": meta["label"],
                "needs_key": meta["needs_key"],
                **self.provider_config(name),
                "default_base_url": meta["base_url"],
                "has_key": bool(key),
                "key_hint": f"…{key[-4:]}" if key and len(key) >= 12 else ("saved" if key else None),
            }
        return {"active": self._config().get("active"), "providers": providers, "stored_in": str(self.folder)}

    def update(self, provider: str, *, model: str | None = None, base_url: str | None = None,
               api_key: str | None = None, clear_key: bool = False, activate: bool | None = None) -> dict:
        if provider not in PROVIDERS:
            raise SettingsError("Unknown provider.")
        config = self._config()
        entry = config.setdefault("providers", {}).setdefault(provider, {})
        if model is not None:
            model = model.strip()
            if len(model) > MAX_FIELD_LENGTH:
                raise SettingsError("The model name is too long.")
            entry["model"] = model
        if base_url is not None:
            entry["base_url"] = _check_url(base_url.strip()) if base_url.strip() else ""
        if activate is True:
            config["active"] = provider
        elif activate is False and config.get("active") == provider:
            config["active"] = None
        if api_key is not None or clear_key:
            secrets = _read(self._secrets_path)
            keys = secrets.setdefault("api_keys", {})
            if clear_key:
                keys.pop(provider, None)
            else:
                api_key = api_key.strip()
                if not api_key:
                    raise SettingsError("Paste a key, or remove the saved one.")
                if len(api_key) > MAX_KEY_LENGTH or any(c.isspace() for c in api_key):
                    raise SettingsError("That doesn't look like an API key (no spaces, at most 512 characters).")
                keys[provider] = api_key
            _write_private(self._secrets_path, secrets)
        _write_private(self._config_path, config)
        return self.public()


def _check_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > MAX_FIELD_LENGTH:
        raise SettingsError("Enter a full address starting with https:// (or http:// for a local server).")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
        raise SettingsError("Use https:// for remote servers; plain http:// is only allowed on this computer.")
    return url.rstrip("/")


# ---------------------------------------------------------------- connection test

def test_connection(settings: AISettings, provider: str, timeout: float = 20) -> dict:
    """Check the address and key by listing the provider's models (no tokens are spent)."""
    if provider not in PROVIDERS:
        raise SettingsError("Unknown provider.")
    cfg = settings.provider_config(provider)
    key = settings.key(provider)
    if provider == "anthropic" and not key:
        return {"ok": False, "message": "Save an API key first."}
    started = time.monotonic()
    try:
        if provider == "anthropic":
            models = _anthropic_models(cfg["base_url"], key, timeout)
        elif provider == "openai":
            models = _openai_models(cfg["base_url"], key, timeout)
        else:
            models = _ollama_models(cfg["base_url"], timeout)
    except _ProviderError as exc:
        return {"ok": False, "message": str(exc)}
    model = cfg["model"]
    result = {"ok": True, "models": models[:300], "latency_ms": int((time.monotonic() - started) * 1000)}
    count = f"{len(models)} model{'s' if len(models) != 1 else ''} available"
    if not model:
        result["message"] = f"Connected · {count}. Choose a model below."
        result["model_found"] = None
    elif models and model not in models:
        result["message"] = f"Connected, but “{model}” isn't in this account's model list."
        result["model_found"] = False
    else:
        result["message"] = f"Connected · {count}."
        result["model_found"] = model in models
    return result


class _ProviderError(Exception):
    pass


def _anthropic_models(base_url: str, key: str, timeout: float) -> list[str]:
    import anthropic

    client = anthropic.Anthropic(api_key=key, base_url=base_url, timeout=timeout, max_retries=1)
    try:
        return [m.id for m in client.models.list(limit=100)]
    except anthropic.AuthenticationError:
        raise _ProviderError("Anthropic refused the key (401). Check that it was copied completely.") from None
    except anthropic.PermissionDeniedError:
        raise _ProviderError("The key works but isn't allowed to list models (403).") from None
    except anthropic.RateLimitError:
        raise _ProviderError("Rate limited by Anthropic (429). Try again in a moment.") from None
    except anthropic.APIStatusError as exc:
        raise _ProviderError(f"Anthropic answered with HTTP {exc.status_code}.") from None
    except anthropic.APIConnectionError:
        raise _ProviderError(f"Couldn't reach {urllib.parse.urlparse(base_url).netloc}. Check your internet connection.") from None


def _get_json(url: str, headers: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    host = urllib.parse.urlparse(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read(4 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise _ProviderError(f"{host} refused the key (HTTP {exc.code}).") from None
        raise _ProviderError(f"{host} answered with HTTP {exc.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise _ProviderError(f"Couldn't reach {host} ({reason}).") from None
    except ValueError:
        raise _ProviderError(f"{host} didn't answer with JSON. Is this the API address?") from None


def _openai_models(base_url: str, key: str | None, timeout: float) -> list[str]:
    data = _get_json(base_url.rstrip("/") + "/models", {"Authorization": f"Bearer {key}"} if key else {}, timeout)
    return sorted(str(m.get("id")) for m in data.get("data", []) if isinstance(m, dict) and m.get("id"))


def _ollama_models(base_url: str, timeout: float) -> list[str]:
    data = _get_json(base_url.rstrip("/") + "/api/tags", {}, timeout)
    return sorted(str(m.get("name")) for m in data.get("models", []) if isinstance(m, dict) and m.get("name"))
