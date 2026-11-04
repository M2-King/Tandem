"""Who may talk to the runtime.

The server only listens on 127.0.0.1. On top of that:

* Host check: every request must name this exact host and port. This stops
  DNS-rebinding pages (evil.example resolving to 127.0.0.1) from reading the
  UI and its session token.
* Session token: every API request and the WebSocket must carry the random
  per-launch token. The UI gets it inside the index page this server serves.
* Origin check: browser requests that change state must come from this
  server's own origin.
"""

from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass, field

TOKEN_HEADER = "x-tandem-token"


def new_token() -> str:
    return secrets.token_urlsafe(32)


@dataclass
class AccessPolicy:
    token: str
    port: int
    # Extra origins allowed to call the API (for example a Vite dev server).
    extra_origins: set[str] = field(default_factory=set)

    @property
    def hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    @property
    def origins(self) -> set[str]:
        return {f"http://{h}" for h in self.hosts} | self.extra_origins

    def host_ok(self, host: str | None) -> bool:
        return host is not None and host.lower() in self.hosts

    def origin_ok(self, origin: str | None) -> bool:
        # Non-browser clients (curl, tests) send no Origin; they still need the token.
        return origin is None or origin in self.origins

    def token_ok(self, presented: str | None) -> bool:
        return presented is not None and hmac.compare_digest(presented, self.token)
