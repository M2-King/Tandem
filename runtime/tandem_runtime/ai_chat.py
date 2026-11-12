"""The assistant: asks the AI provider chosen in AI settings about the project.

The model gets the files the request is about, the latest run of that file
(output and traceback), the project's file list and the recent conversation.
When it proposes a change it returns one complete new version of one file;
the UI shows that as a diff and nothing is written until the person accepts
it. Nothing here runs code.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .ai_settings import PROVIDERS, AISettings
from .files import FileError, ProjectFiles

MAX_FILE_CHARS = 120_000  # per file sent to the model
MAX_OUTPUT_CHARS = 6_000  # tail of the last run's output
MAX_HISTORY = 12  # earlier messages kept for follow-ups
MAX_TOKENS = 16_000
# Models that take the server-side refusal fallback ("default" form).
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}

SYSTEM = """You are the coding assistant inside Tandem, a Python editor. The developer runs their code with their own Python 3 on their computer; Tandem shows the output, charts, variables and tracebacks. Scripts can read input: the developer types it in Tandem's Output panel.

Be concise and specific, like a senior colleague. Name lines and variables.

When the developer asks for a change, or asks you to fix an error, propose ONE complete new version of ONE file in exactly this format:

<tandem-file path="relative/path.py">
...the complete new file content, every line...
</tandem-file>

Before the block, write one or two sentences saying what you changed and why. After the block, list the changes as short lines starting with "- ". Keep the developer's style and change only what is needed. Do not use a file block when you are only explaining or answering. Never claim you ran the code."""

_FILE_BLOCK = re.compile(r'<tandem-file path="([^"\n]+)">\n?(.*?)\n?</tandem-file>', re.DOTALL)


class AssistError(Exception):
    """A request that couldn't be answered; the message is safe to show."""


def active_provider(settings: AISettings) -> dict | None:
    """The provider the assistant uses, or None if none is set up."""
    data = settings.public()
    name = data.get("active")
    if name not in PROVIDERS:
        return None
    cfg = settings.provider_config(name)
    if not cfg.get("model"):
        return None
    if name == "anthropic" and not settings.key(name):
        return None
    return {"provider": name, "label": PROVIDERS[name]["label"], "model": cfg["model"], "base_url": cfg["base_url"]}


def _project_paths(request: dict, files: ProjectFiles) -> list[str]:
    """The project's file list: a shared project's comes with the request."""
    given = request.get("file_list")
    if isinstance(given, list):
        return [str(p) for p in given if isinstance(p, str)][:300]
    return [f["path"] for f in files.list()][:300]


def _context_message(request: dict, files: ProjectFiles) -> str:
    """The user turn: files, last run, selection and the request itself."""
    parts = []
    listed = _project_paths(request, files)
    parts.append("Project files:\n" + "\n".join(f"- {p}" for p in listed))

    contents = request.get("files") or {}
    for path, text in list(contents.items())[:6]:
        if not isinstance(text, str):
            continue
        try:
            files.resolve(path)
        except FileError:
            continue
        clipped = text if len(text) <= MAX_FILE_CHARS else text[:MAX_FILE_CHARS] + "\n# … (file truncated)"
        numbered = "\n".join(f"{i + 1:>4}  {line}" for i, line in enumerate(clipped.split("\n")))
        parts.append(f'File {path} (line numbers added for reference, not part of the file):\n{numbered}')

    active = request.get("active_path")
    if active:
        parts.append(f"The developer has {active} open.")
    for chip in request.get("context") or []:
        if chip.get("type") == "selection":
            parts.append(f"They selected lines {chip.get('startLine')}–{chip.get('endLine')} of {chip.get('path')}.")
        elif chip.get("type") == "error":
            parts.append(f"They are asking about the error in {chip.get('path')} at line {chip.get('line')}.")
        elif chip.get("type") == "chart":
            parts.append(f"They are asking about a chart: {chip.get('label')}.")

    run = request.get("last_run")
    if isinstance(run, dict) and run.get("path"):
        out = str(run.get("output") or "")[-MAX_OUTPUT_CHARS:]
        lines = [f"Latest run of {run['path']}: {run.get('status')} (exit code {run.get('exit_code')})."]
        err = run.get("error")
        if isinstance(err, dict) and err.get("type"):
            where = f" at {err.get('path')} line {err.get('line')}" if err.get("line") else ""
            lines.append(f"Error: {err.get('type')}: {err.get('message')}{where}.")
        if out.strip():
            lines.append("Output (stdout and stderr, last part):\n" + out)
        parts.append("\n".join(lines))

    intent = request.get("intent") or "chat"
    hint = {"fix": " (they want a fix)", "explain": " (they want an explanation, no change)"}.get(intent, "")
    parts.append(f"Request{hint}: {request.get('prompt', '').strip()}")
    return "\n\n".join(parts)


def _history(request: dict) -> list[dict]:
    out = []
    for m in (request.get("history") or [])[-MAX_HISTORY:]:
        role = "assistant" if m.get("role") == "assistant" else "user"
        text = str(m.get("text") or "").strip()
        if text:
            out.append({"role": role, "content": text[:8000]})
    # Providers want turns to alternate and to start with the user.
    merged: list[dict] = []
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n\n" + m["content"]
        else:
            merged.append(dict(m))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    if merged and merged[-1]["role"] == "user":
        merged.append({"role": "assistant", "content": "(noted)"})
    return merged


# ---------------------------------------------------------------- providers

def _ask_anthropic(cfg: dict, key: str, messages: list[dict], timeout: float) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=key, base_url=cfg["base_url"], timeout=timeout, max_retries=1)
    params = {"model": cfg["model"], "max_tokens": MAX_TOKENS, "system": SYSTEM, "messages": messages}
    try:
        if cfg["model"] in FALLBACK_MODELS and cfg["base_url"].rstrip("/") == PROVIDERS["anthropic"]["base_url"]:
            # If a safety classifier declines, Anthropic retries on a fallback model in the same call.
            response = client.beta.messages.create(**params, betas=["server-side-fallback-2026-07-01"],
                                                   fallbacks="default")
        else:
            response = client.messages.create(**params)
    except anthropic.AuthenticationError:
        raise AssistError("Anthropic refused the API key (401). Check it in AI settings.") from None
    except anthropic.PermissionDeniedError:
        raise AssistError("This API key isn't allowed to use that model (403).") from None
    except anthropic.NotFoundError:
        raise AssistError(f"Anthropic doesn't know the model “{cfg['model']}”. Pick one in AI settings.") from None
    except anthropic.RateLimitError:
        raise AssistError("Rate limited by Anthropic (429). Try again in a moment.") from None
    except anthropic.APIStatusError as exc:
        raise AssistError(f"Anthropic answered with HTTP {exc.status_code}.") from None
    except anthropic.APIConnectionError:
        raise AssistError("Couldn't reach Anthropic. Check your internet connection.") from None
    if response.stop_reason == "refusal":
        raise AssistError("The model declined this request.")
    text = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
    if response.stop_reason == "max_tokens":
        text += "\n\n[cut off: the answer was too long]"
    return text


def _post_json(url: str, body: dict, headers: dict, timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
    host = urllib.parse.urlparse(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read(16 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read(4000)).get("error", "")
            detail = detail.get("message", "") if isinstance(detail, dict) else str(detail)
        except Exception:
            pass
        if exc.code in (401, 403):
            raise AssistError(f"{host} refused the key (HTTP {exc.code}). Check it in AI settings.") from None
        raise AssistError(f"{host} answered with HTTP {exc.code}{': ' + detail[:200] if detail else ''}.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AssistError(f"Couldn't reach {host} ({getattr(exc, 'reason', exc)}).") from None
    except ValueError:
        raise AssistError(f"{host} didn't answer with JSON.") from None


def _ask_openai(cfg: dict, key: str | None, messages: list[dict], timeout: float) -> str:
    data = _post_json(cfg["base_url"].rstrip("/") + "/chat/completions",
                      {"model": cfg["model"], "messages": [{"role": "system", "content": SYSTEM}, *messages]},
                      {"Authorization": f"Bearer {key}"} if key else {}, timeout)
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise AssistError("The server's answer had no message in it.") from None


def _ask_ollama(cfg: dict, messages: list[dict], timeout: float) -> str:
    data = _post_json(cfg["base_url"].rstrip("/") + "/api/chat",
                      {"model": cfg["model"], "stream": False,
                       "messages": [{"role": "system", "content": SYSTEM}, *messages]}, {}, timeout)
    try:
        return data["message"]["content"] or ""
    except (KeyError, TypeError):
        raise AssistError("Ollama's answer had no message in it.") from None


def _ask_shared(shared: dict, request: dict, timeout: float) -> dict:
    """A shared project's AI, shared by its owner: the cowork-ai Edge Function
    (supabase/functions/cowork-ai) writes the instructions, reads the files
    from the project and adds the owner's key on the server. This sends only
    the question and what it points at; the app has saved its edits first."""
    url = str(shared.get("url") or "")
    if not re.match(r"^(https://|http://(127\.0\.0\.1|localhost)(:\d+)?/)", url):
        raise AssistError("The shared AI's address isn't valid.")
    body = {
        "project_id": shared.get("project_id"),
        "mode": "python",
        "prompt": request.get("prompt", ""),
        "intent": request.get("intent") or "chat",
        "context": request.get("context") or [],
        "active_path": request.get("active_path"),
        "paths": list((request.get("files") or {}).keys())[:6],
        "last_run": request.get("last_run"),
        "history": [{"role": m.get("role"), "text": m.get("text")} for m in (request.get("history") or [])][-8:],
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "Authorization": f"Bearer {shared.get('token') or ''}", "apikey": str(shared.get("apikey") or ""),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read(16 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = ""
        try:
            message = str(json.loads(exc.read(4000)).get("error") or "")
        except Exception:
            pass
        raise AssistError(message or f"The shared AI answered with HTTP {exc.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AssistError("Couldn't reach the shared AI. Check your internet connection.") from None
    except ValueError:
        raise AssistError("The shared AI didn't answer with JSON.") from None
    if data.get("stop_reason") == "refusal":
        raise AssistError("The model declined this request.")
    text = str(data.get("text") or "")
    if data.get("stop_reason") == "max_tokens":
        text += "\n\n[cut off: the answer was too long]"
    return {**data, "text": text}


# ---------------------------------------------------------------- the request

def parse_reply(text: str, request: dict, files: ProjectFiles) -> dict:
    """Turn the model's text into an answer, or a proposal for one file."""
    match = _FILE_BLOCK.search(text)
    if not match:
        return {"kind": "answer", "text": text.strip() or "(The model returned an empty answer.)"}
    path = match.group(1).strip()
    if path.startswith("./"):
        path = path[2:]
    try:
        files.resolve(path)
    except FileError:
        return {"kind": "answer", "text": f"The model proposed a change to {path}, which is outside this project, so it was ignored.\n\n" + text[:match.start()].strip()}
    new = match.group(2)
    base = (request.get("files") or {}).get(path)
    # (A shared project's files aren't this device's: only what came with the request.)
    if base is None and not isinstance(request.get("file_list"), list):
        try:
            base = files.read(path).get("text")
        except FileError:
            base = None
    if base is not None and base.endswith("\n") and not new.endswith("\n"):
        new += "\n"
    before = text[: match.start()].strip()
    after = text[match.end():].strip()
    summary = [line[2:].strip() for line in after.splitlines() if line.strip().startswith(("- ", "* "))][:8]
    extra = "\n".join(line for line in after.splitlines() if not line.strip().startswith(("- ", "* "))).strip()
    if base is not None and new == base:
        return {"kind": "answer", "text": (before + ("\n\n" + extra if extra else "")).strip() + "\n\n(The suggested file is the same as yours, so there is nothing to apply.)"}
    return {
        "kind": "proposal",
        "path": path,
        "new_content": new,
        "text": before or f"Proposed change to {path}.",
        "summary": summary,
        "new_file": base is None,
    }


def assist(settings: AISettings, files: ProjectFiles, request: dict, timeout: float = 300) -> dict:
    provider = active_provider(settings)
    shared = request.get("shared_ai")
    if isinstance(shared, dict):
        # The AI the project's owner shares: the app sends it when it is the
        # one to use (no AI of your own, or chosen for this project).
        started = time.monotonic()
        answer = _ask_shared(shared, request, timeout)
        result = parse_reply(answer["text"], request, files)
        result["model"] = answer.get("model") or ""
        result["provider"] = f"Shared by {answer.get('shared_by') or 'the owner'}"
        result["shared"] = {k: answer.get(k) for k in ("shared_by", "used_today", "daily_limit", "unlimited")}
        result["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        return result
    if provider is None:
        return {
            "kind": "setup",
            "text": "No AI model is connected yet. Open **AI settings**, add your Anthropic, OpenAI-compatible or Ollama "
                    "model, and use it for the assistant. Then ask again."
                    + (" In a shared project, an owner can also share their AI with everyone in it (**Share**, then "
                       "**Share your AI**)." if isinstance(request.get("file_list"), list) else ""),
        }
    messages = _history(request) + [{"role": "user", "content": _context_message(request, files)}]
    started = time.monotonic()
    cfg = {"model": provider["model"], "base_url": provider["base_url"]}
    name = provider["provider"]
    if name == "anthropic":
        text = _ask_anthropic(cfg, settings.key("anthropic"), messages, timeout)
    elif name == "openai":
        text = _ask_openai(cfg, settings.key("openai"), messages, timeout)
    else:
        text = _ask_ollama(cfg, messages, timeout)
    result = parse_reply(text, request, files)
    result["model"] = provider["model"]
    result["provider"] = provider["label"]
    result["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    return result
