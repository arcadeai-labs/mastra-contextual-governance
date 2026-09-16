"""Slack, over the requester's own delegated token.

Act 2 posts **as the requester**, not as a bot. Arcade's stock Slack provider
issues a user token (`xoxp`) because it requests scopes as `user_scope`, so the
DM arrives under Alice's name and avatar with no APP badge — measured end to end
in `docs/spikes/03-slack-scopes.md` (#3). There is no bot token anywhere in this
repo and no custom Slack app; the spike records both fallbacks for a forker who
wants one.

The token reaches a tool as `context.authorization.token` and is never cached:
`auth.test` reported a ~12 h life, and Arcade holds the refresh token and renews
on demand.

Slack's Web API answers `200 OK` with `{"ok": false, "error": "..."}` for
application-level failures, so a bare status check would read every refusal as
a success. `_call` raises on `ok: false`, which is what turns "the DM silently
never arrived" into a tool error the agent reports.

`SLACK_API_BASE_URL` overrides the endpoint. That exists so the tests can drive
a stand-in Slack rather than mocking the client under test; nothing sets it in
production and the default is Slack itself.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

__all__ = [
    "SLACK_SCOPES",
    "SlackError",
    "api_base_url",
    "lookup_user_by_email",
    "open_direct_message",
    "post_message",
]

#: Exactly the scopes spike #3 exercised, in the order it lists them. Four
#: rather than three because `users:read` is a prerequisite for
#: `users:read.email`: Slack refuses the authorize request outright without it
#: — "Arcade.dev could not be installed. Invalid permissions requested", before
#: any consent screen (spike #3, transcript §8). `im:write` is what
#: `conversations.open` needs, and opening the DM is how the spike reached the
#: approver. Pinned in `.env.example` alongside this list.
SLACK_SCOPES = ["chat:write", "im:write", "users:read", "users:read.email"]

_DEFAULT_API_BASE_URL = "https://slack.com/api"
_ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz"
_ASCII_DIGITS = "0123456789"


def _has_safe_shape(
    text: str, *, first: str, rest: str, max_length: int = 80
) -> bool:
    return bool(text) and len(text) <= max_length and text[0] in first and all(
        char in rest for char in text[1:]
    )


def _safe_identifier(value: object, fallback: str) -> str:
    """Keep machine labels useful without echoing arbitrary upstream text."""
    text = str(value or "").strip()
    safe = _ASCII_LETTERS + _ASCII_DIGITS + "_.-"
    return text if _has_safe_shape(text, first=_ASCII_LETTERS, rest=safe) else fallback


def _safe_detail_value(value: object) -> str:
    """Return only scope-like detail that is safe to put in diagnostics.

    Slack's refusal payload can grow new fields over time. Never serialise that
    payload wholesale: it can contain request data, identifiers, or credentials
    supplied by an intermediary. The only detail we currently need operationally
    is the scope Slack says is needed or was provided, and those values have a
    deliberately narrow grammar.
    """
    values = value if isinstance(value, list) else [value]
    safe = []
    scope_chars = _ASCII_LOWERCASE + _ASCII_DIGITS + "_.:-"
    for item in values:
        if not isinstance(item, str):
            continue
        for text in item.split(","):
            text = text.strip()
            if _has_safe_shape(text, first=_ASCII_LOWERCASE, rest=scope_chars):
                safe.append(text)
    return ",".join(safe[:20])


def _safe_response_detail(body: dict[str, Any]) -> str:
    """Extract the useful, non-sensitive part of a Slack response."""
    details = []
    for key in ("needed", "provided"):
        value = _safe_detail_value(body.get(key))
        if value:
            details.append(f"{key}={value}")
    return "; ".join(details)


def _safe_detail_text(detail: object) -> str:
    """Re-validate formatted detail even when a caller constructs SlackError."""
    if not isinstance(detail, str):
        return ""
    details = []
    for part in detail.split(";"):
        key, separator, value = part.partition("=")
        key = key.strip()
        if separator and key in {"needed", "provided"}:
            safe = _safe_detail_value(value)
            if safe:
                details.append(f"{key}={safe}")
    return "; ".join(details)


class SlackError(Exception):
    """Slack answered, and said no. `error` is Slack's own machine-readable code."""

    def __init__(self, method: str, error: str, detail: str = "") -> None:
        self.method = _safe_identifier(method, "unknown_method")
        self.error = _safe_identifier(error, "unknown_error")
        self.detail = _safe_detail_text(detail)
        super().__init__(f"Slack {self.method} failed: {self.error}")

    def diagnostic_message(self) -> str:
        """A useful server-side summary with no raw Slack response or request data."""
        suffix = f"; detail={self.detail}" if self.detail else ""
        return f"Slack {self.method} failed with code {self.error}{suffix}"


def api_base_url() -> str:
    """Where the Slack Web API lives. Overridable for tests; see the module docstring."""
    return os.environ.get("SLACK_API_BASE_URL", _DEFAULT_API_BASE_URL).rstrip("/")


async def _call(token: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = f"{api_base_url()}/{method}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(url, json=payload, headers=headers)

    if response.status_code != 200:
        # Do not include response.text in an exception. A proxy or an upstream
        # failure page is not controlled by this toolkit and may echo headers,
        # credentials, or the request body. The status is enough to diagnose a
        # transport-level refusal; application-level detail is handled below.
        raise SlackError(method, f"http_{response.status_code}")

    try:
        decoded = response.json()
    except ValueError as exc:  # pragma: no cover - Slack always answers JSON
        raise SlackError(method, "unparseable_response") from exc

    body = decoded if isinstance(decoded, dict) else {}

    # A 200 with ok:false is Slack's normal shape for a refusal. Reading only
    # the status code would treat "not_in_channel" or "missing_scope" as a
    # delivered message.
    if not body.get("ok"):
        raise SlackError(
            method,
            body.get("error", "unknown"),
            _safe_response_detail(body),
        )
    return body


async def lookup_user_by_email(token: str, email: str) -> str:
    """Resolve an email to a Slack user id. Needs `users:read.email`."""
    body = await _call(token, "users.lookupByEmail", {"email": email})
    user = body.get("user") or {}
    user_id = user.get("id")
    if not user_id:
        raise SlackError("users.lookupByEmail", "no_user_id_in_response")
    return str(user_id)


async def open_direct_message(token: str, user_id: str) -> str:
    """Open the DM with a Slack user and return its `D…` channel id.

    Needs `im:write`. This is the call spike #3 exercised, and posting to the
    channel it returns is the path that was measured end to end — rather than
    handing `chat.postMessage` a bare user id and trusting Slack to resolve it,
    which nothing here has observed.
    """
    body = await _call(token, "conversations.open", {"users": user_id})
    channel = (body.get("channel") or {}).get("id")
    if not channel:
        raise SlackError("conversations.open", "no_channel_in_response")
    return str(channel)


async def post_message(
    token: str, channel: str, text: str, blocks: list[dict[str, Any]]
) -> dict[str, str]:
    """Post to `channel` — for a DM, the `D…` id `open_direct_message` returned.

    `text` is not decoration. Slack uses it for notification previews and for
    clients that cannot render blocks, so a message with blocks and no text
    arrives as a silent, empty push.
    """
    body = await _call(
        token, "chat.postMessage", {"channel": channel, "text": text, "blocks": blocks}
    )
    return {"channel": str(body.get("channel", "")), "ts": str(body.get("ts", ""))}
