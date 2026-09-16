"""Stand-ins for the two services this toolkit talks to, and nothing else.

The tools are stateless clients — of the approvals store in `apps/hooks`, and
of Slack. Neither is mocked: both are small real HTTP servers, bound to port 0
so nothing in this suite can collide with a dev server or with another
worktree's port block, and the tools reach them over the wire exactly as they
would reach the real thing. What the tests then assert is what actually arrived.

`_StoreHandler` doubles as the executable specification of the contract written
out under "The approvals store contract" in `tools/approvals/README.md`. When
#19 implements those endpoints in `apps/hooks`, this file is what they have to
satisfy, and `test_store_contract.py` is what says so out loud — including the
`GET /approvals/{id}` read that #19's page is built on and that nothing in this
toolkit calls.

`FakeSlack` is a Slack that answers the way Slack answers: `200 OK` with
`{"ok": false, "error": …}` for a refusal, which is the shape a client that
only checks status codes reads as success. It serves the three methods spike #3
exercised — `users.lookupByEmail`, `conversations.open`, `chat.postMessage` —
and nothing else, so a call the spike never measured fails here too.

The roster comes from `packages/policy-schema/contract/approver-routing-cases.json`,
the same file `test_routing.py` and the TypeScript router read, so the cast a
tool test routes over cannot drift from the cast the routing rule is pinned
against.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from arcade_core.schema import ToolAuthorizationContext, ToolContext, ToolSecretItem

from approvals import APPROVALS_STORE_TOKEN_SECRET, HOOKS_HOST_SECRET, WEB_HOST_SECRET
from tests.test_routing import CASES, SUBJECTS

STORE_TOKEN = "store-token-for-tests"
SLACK_TOKEN = "xoxp-test-token"
WEB_HOST = "cg-web.example.test"

DANA = SUBJECTS["dana"]
SAM = SUBJECTS["sam"]
RILEY = SUBJECTS["riley"]
MORGAN = SUBJECTS["morgan"]
CAST = [SUBJECTS[key] for key in CASES["cast"]]


# ---------------------------------------------------------------------------
# The approvals store, as apps/hooks will serve it
# ---------------------------------------------------------------------------


#: Every field the contract in `tools/approvals/README.md` says a record
#: carries. Named here so the stand-in and the tests agree on completeness, and
#: so a field dropped from the record is a failing test rather than a page in
#: #19 that renders a blank.
RECORD_FIELDS = (
    "id",
    "requester_id",
    "requester_display_name",
    "approver_id",
    "approver_display_name",
    "candidate_approver_ids",
    "action",
    "resource_id",
    "amount",
    "required_clearance",
    "rule",
    "justification",
    "status",
    "created_at",
    "decided_at",
    "decided_by",
    "note",
)


@dataclass
class StoreState:
    roster: list[dict[str, Any]]
    #: The policy rule the blocked call tripped, carried on every record.
    #: `None` exercises the branch where the control plane cannot name it.
    rule: dict[str, str] | None = None
    #: Every request body the toolkit sent, so a test can assert what was persisted.
    created: list[dict[str, Any]] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    records: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Set to a status code to make the next call fail.
    fail_with: int | None = None
    seq: int = 0
    #: Filled in by the fixture once the OS has picked a port.
    host: str = ""


class _StoreHandler(BaseHTTPRequestHandler):
    state: StoreState

    def _send(self, code: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorised(self) -> bool:
        header = self.headers.get("Authorization") or ""
        return header == f"Bearer {STORE_TOKEN}"

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _display_name(self, user_id: str) -> str:
        """From the roster, so #19's page never has to join two responses."""
        for subject in self.state.roster:
            if subject["user_id"] == user_id:
                return str(subject["display_name"])
        return user_id

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorised():
            self._send(401, {"error": "unauthorised"})
            return
        if self.path == "/approvals/roster":
            self._send(200, {"subjects": self.state.roster})
            return

        # The read #19's approval page is built on. Nothing in this toolkit
        # calls it; it is here because the contract has to be executable.
        if self.path.startswith("/approvals/"):
            request_id = self.path.removeprefix("/approvals/")
            record = self.state.records.get(request_id)
            if record is None:
                self._send(404, {"error": f"no approval request {request_id}"})
                return
            self._send(200, {"request": record})
            return

        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorised():
            self._send(401, {"error": "unauthorised"})
            return
        if self.state.fail_with is not None:
            code, self.state.fail_with = self.state.fail_with, None
            self._send(code, {"error": "the approvals store is unavailable"})
            return

        if self.path == "/approvals":
            body = self._body()
            self.state.created.append(body)
            self.state.seq += 1
            # The store mints the id and the timestamp. A server clock and a
            # server id: an id the model could predict is an id it could ask
            # about before anyone approved it.
            record = {
                "id": f"apr_{self.state.seq:012x}",
                "requester_id": body["requester_id"],
                "requester_display_name": self._display_name(body["requester_id"]),
                "approver_id": body["approver_id"],
                "approver_display_name": self._display_name(body["approver_id"]),
                "candidate_approver_ids": body["candidate_approver_ids"],
                "action": body["action"],
                "resource_id": body["resource_id"],
                "amount": body["amount"],
                "required_clearance": body["required_clearance"],
                "rule": self.state.rule,
                "justification": body["justification"],
                "status": "pending",
                "created_at": "2026-09-09T12:00:00.000Z",
                "decided_at": None,
                "decided_by": None,
                "note": None,
            }
            self.state.records[record["id"]] = record
            self._send(201, {"request": record})
            return

        if self.path.startswith("/approvals/") and self.path.endswith("/decision"):
            request_id = self.path.removeprefix("/approvals/").removesuffix("/decision")
            record = self.state.records.get(request_id)
            if record is None:
                self._send(404, {"error": f"no approval request {request_id}"})
                return
            body = self._body()
            self.state.decisions.append({"request_id": request_id, **body})
            # The same complete shape the create and the read return. There is
            # no separate `decision` field: once decided, `status` is it.
            record = {
                **record,
                "status": body["decision"],
                "note": body["note"],
                "decided_at": "2026-09-09T12:05:00.000Z",
                "decided_by": body["decided_by"],
            }
            self.state.records[request_id] = record
            self._send(200, {"request": record})
            return

        self._send(404, {"error": "not found"})

    def log_message(self, *_: object) -> None:
        pass


# ---------------------------------------------------------------------------
# Slack
# ---------------------------------------------------------------------------


@dataclass
class SlackState:
    #: email -> Slack user id, as users.lookupByEmail resolves them.
    users: dict[str, str]
    #: Slack user id -> the `D…` channel conversations.open returns for them.
    dms: dict[str, str] = field(default_factory=dict)
    posted: list[dict[str, Any]] = field(default_factory=list)
    #: Every Slack method that was called, in order.
    calls: list[str] = field(default_factory=list)
    #: The actual HTTP requests, captured at the loopback boundary.
    requests: list[dict[str, Any]] = field(default_factory=list)
    #: The recipient email handed to users.lookupByEmail.
    looked_up_emails: list[str] = field(default_factory=list)
    #: Slack's own error code to answer the next call with, if any.
    fail_with: str | None = None
    #: Restrict the injected failure to one of the three delivery calls.
    fail_on: str | None = None
    #: Extra response fields used to prove diagnostics do not echo raw data.
    fail_detail: dict[str, Any] = field(default_factory=dict)
    seen_tokens: list[str] = field(default_factory=list)
    #: Filled in by the fixture once the OS has picked a port.
    host: str = ""


class _SlackHandler(BaseHTTPRequestHandler):
    state: SlackState

    def _send(self, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        # Slack answers 200 even when it is refusing. That is the whole reason
        # `slack.py` reads `ok` rather than the status code.
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _request(self) -> tuple[str, bytes, dict[str, list[str]]]:
        target = urlsplit(self.path)
        method = target.path.removeprefix("/api/")
        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length)
        self.state.calls.append(method)
        self.state.seen_tokens.append(
            (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        )
        self.state.requests.append(
            {
                "method": self.command,
                "path": target.path,
                "query": target.query,
                "body": raw_body,
                "authorization": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
            }
        )
        return method, raw_body, parse_qs(target.query, keep_blank_values=True)

    def _maybe_fail(self, method: str) -> bool:
        if self.state.fail_with is None or (
            self.state.fail_on is not None and self.state.fail_on != method
        ):
            return False
        error, self.state.fail_with = self.state.fail_with, None
        self._send({"ok": False, "error": error, **self.state.fail_detail})
        return True

    def do_GET(self) -> None:  # noqa: N802
        method, raw_body, query = self._request()
        if self._maybe_fail(method):
            return

        if method == "users.lookupByEmail":
            # The real endpoint takes exactly one email query argument. Keeping
            # this stand-in strict makes the pre-change POST/JSON transport fail
            # instead of silently teaching the test whatever the client sends.
            emails = query.get("email", [])
            if set(query) != {"email"} or len(emails) != 1 or raw_body:
                self._send({"ok": False, "error": "invalid_arguments"})
                return
            email = emails[0]
            self.state.looked_up_emails.append(email)
            user_id = self.state.users.get(email)
            if user_id is None:
                self._send({"ok": False, "error": "users_not_found"})
                return
            self._send({"ok": True, "user": {"id": user_id}})
            return

        self._send({"ok": False, "error": "unknown_method"})

    def do_POST(self) -> None:  # noqa: N802
        method, raw_body, _ = self._request()
        body = json.loads(raw_body or b"{}")
        if self._maybe_fail(method):
            return

        if method == "conversations.open":
            user_id = body.get("users", "")
            channel = self.state.dms.get(user_id)
            if channel is None:
                self._send({"ok": False, "error": "user_not_found"})
                return
            self._send({"ok": True, "channel": {"id": channel}})
            return

        if method == "chat.postMessage":
            self.state.posted.append(body)
            self._send({"ok": True, "channel": body.get("channel"), "ts": "1757419200.000100"})
            return

        self._send({"ok": False, "error": "unknown_method"})

    def log_message(self, *_: object) -> None:
        pass


def _serve(handler_class: type[BaseHTTPRequestHandler]) -> tuple[ThreadingHTTPServer, str]:
    # Port 0: the OS picks a free one and hands it back. Never a literal, and
    # never a guess — this worktree owns a port block and the reviewer's owns a
    # different one.
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_class)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"127.0.0.1:{server.server_port}"


@pytest.fixture
def store() -> StoreState:
    state = StoreState(roster=[_as_dict(subject) for subject in CAST])
    handler = type("_Bound", (_StoreHandler,), {"state": state})
    server, host = _serve(handler)
    state.host = host
    yield state
    server.shutdown()
    server.server_close()


@pytest.fixture
def slack() -> SlackState:
    state = SlackState(
        users={
            DANA.user_id: "U_DANA",
            SAM.user_id: "U_SAM",
            RILEY.user_id: "U_RILEY",
            MORGAN.user_id: "U_MORGAN",
        },
        dms={"U_DANA": "D_DANA", "U_SAM": "D_SAM", "U_RILEY": "D_RILEY", "U_MORGAN": "D_MORGAN"},
    )
    handler = type("_Bound", (_SlackHandler,), {"state": state})
    server, host = _serve(handler)
    state.host = host
    previous = os.environ.get("SLACK_API_BASE_URL")
    os.environ["SLACK_API_BASE_URL"] = f"http://{host}/api"
    yield state
    if previous is None:
        os.environ.pop("SLACK_API_BASE_URL", None)
    else:
        os.environ["SLACK_API_BASE_URL"] = previous
    server.shutdown()
    server.server_close()


def _as_dict(subject: Any) -> dict[str, Any]:
    return {
        "user_id": subject.user_id,
        "display_name": subject.display_name,
        "role": subject.role,
        "clearance": subject.clearance,
        "attributes": {},
    }


def make_context(store_host: str, user_id: str, slack_token: str = SLACK_TOKEN) -> ToolContext:
    """What the Arcade engine hands a tool at runtime: a token, secrets, an identity."""
    return ToolContext(
        authorization=ToolAuthorizationContext(token=slack_token),
        secrets=[
            ToolSecretItem(key=HOOKS_HOST_SECRET, value=store_host),
            ToolSecretItem(key=WEB_HOST_SECRET, value=WEB_HOST),
            ToolSecretItem(key=APPROVALS_STORE_TOKEN_SECRET, value=STORE_TOKEN),
        ],
        user_id=user_id,
    )


@pytest.fixture
def as_dana(store: StoreState) -> ToolContext:
    return make_context(store.host, DANA.user_id)


@pytest.fixture
def as_riley(store: StoreState) -> ToolContext:
    return make_context(store.host, RILEY.user_id)


@pytest.fixture
def as_morgan(store: StoreState) -> ToolContext:
    return make_context(store.host, MORGAN.user_id)
