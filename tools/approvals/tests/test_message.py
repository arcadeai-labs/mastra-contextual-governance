"""The Block Kit payload, as Slack will receive it.

There is no live Slack in this suite. That is deliberate and it is not a gap:
the thing worth pinning is the payload, and a payload is checkable exactly.
Spike #3 already ran this shape past the real API and photographed the render
(`docs/spikes/evidence/03-slack-block-kit-render.png`); what these tests defend
is that the message keeps saying everything the approver needs, and keeps not
carrying authority in its link.
"""

from __future__ import annotations

import json

import pytest

from approvals.message import ApprovalMessage, build_blocks, build_fallback_text, format_amount

ACT_TWO = ApprovalMessage(
    request_id="apr_7f3c1a9e42b8",
    requester_display_name="Alice",
    requester_id="alice@example.com",
    approver_display_name="Charlie",
    action="approve_loan",
    resource_id="LN-2291",
    amount=95_000,
    justification=(
        "Northwind Bakery has 11 years in business, a 742 credit score and "
        "$1.4M annual revenue; the requested amount is within their coverage."
    ),
    rule_tripped=(
        "approve_loan for $95,000.00 exceeds Alice's approval authority "
        "of $50,000.00."
    ),
    approval_url="https://cg-web.example.test/approvals/apr_7f3c1a9e42b8",
    candidate_display_names=("Charlie", "Michael"),
)


def rendered(message: ApprovalMessage) -> str:
    return json.dumps(build_blocks(message))


class TestItIsBlockKit:
    def test_every_block_declares_a_type_slack_knows(self) -> None:
        allowed = {"header", "section", "actions", "context", "divider"}
        blocks = build_blocks(ACT_TWO)
        assert blocks, "an empty blocks array posts as a bare text message"
        for block in blocks:
            assert block["type"] in allowed, block

    def test_the_header_is_plain_text_and_the_body_is_mrkdwn(self) -> None:
        blocks = build_blocks(ACT_TWO)
        header = blocks[0]
        assert header["type"] == "header"
        assert header["text"]["type"] == "plain_text"
        fields = blocks[1]["fields"]
        assert all(field["type"] == "mrkdwn" for field in fields)

    def test_stays_inside_slacks_own_limits(self) -> None:
        # A long justification must not turn into `invalid_blocks` at the one
        # moment the demo depends on the DM arriving.
        long_message = ApprovalMessage(
            **{**ACT_TWO.__dict__, "justification": "why " * 2_000}
        )
        blocks = build_blocks(long_message)
        header = next(b for b in blocks if b["type"] == "header")
        assert len(header["text"]["text"]) <= 150
        for block in blocks:
            if block.get("text"):
                assert len(block["text"]["text"]) <= 3_000
            for field in block.get("fields", []):
                assert len(field["text"]) <= 2_000
        assert len(blocks) <= 50

    def test_carries_a_fallback_text_for_notifications(self) -> None:
        text = build_fallback_text(ACT_TWO)
        assert "Alice" in text
        assert "LN-2291" in text
        assert "$95,000.00" in text


class TestItSaysEverythingTheApproverNeeds:
    @pytest.mark.parametrize(
        ("what", "expected"),
        [
            ("requester", "Alice"),
            ("requester identity", "alice@example.com"),
            ("action", "approve_loan"),
            ("resource", "LN-2291"),
            ("amount", "$95,000.00"),
            ("rule tripped", "exceeds Alice's approval authority"),
            ("justification", "Northwind Bakery has 11 years in business"),
        ],
    )
    def test_states_the(self, what: str, expected: str) -> None:
        assert expected in rendered(ACT_TWO), what

    def test_labels_each_field_so_the_approver_does_not_have_to_infer(self) -> None:
        payload = rendered(ACT_TWO)
        for label in ("*Requester*", "*Action*", "*Resource*", "*Amount*",
                      "*Policy rule tripped*", "*Justification given*"):
            assert label in payload, label

    def test_names_who_was_deliberately_not_asked(self) -> None:
        # "$95K goes to Charlie, not Michael" is the line the presenter says out
        # loud; the message is where the audience reads it.
        payload = rendered(ACT_TWO)
        assert "Routed to Charlie" in payload
        assert "Not asked: Michael" in payload

    def test_a_sole_candidate_produces_no_empty_not_asked_clause(self) -> None:
        sole = ApprovalMessage(**{**ACT_TWO.__dict__, "candidate_display_names": ("Charlie",)})
        assert "Not asked" not in rendered(sole)


class TestTheLinkCarriesNoAuthority:
    def test_the_button_url_is_the_request_id_and_nothing_else(self) -> None:
        button = next(
            element
            for block in build_blocks(ACT_TWO)
            if block["type"] == "actions"
            for element in block["elements"]
        )
        assert button["url"] == "https://cg-web.example.test/approvals/apr_7f3c1a9e42b8"
        assert "?" not in button["url"], "a query string is where a token would arrive"
        assert "#" not in button["url"]

    @pytest.mark.parametrize(
        "smell", ["token", "signature", "sig=", "hmac", "jwt", "secret", "key=", "grant"]
    )
    def test_nothing_in_the_payload_looks_like_a_capability(self, smell: str) -> None:
        # The requester can read the DM she sent. Possession of this message
        # must not be the same as permission — authorization happens at click
        # time (#19). This design was explicitly rejected once; the test is
        # what stops it being added back as a convenience.
        assert smell not in rendered(ACT_TWO).lower(), smell

    def test_the_message_says_so_in_words_as_well(self) -> None:
        assert "does not authorise anything" in rendered(ACT_TWO)


class TestFormatting:
    @pytest.mark.parametrize(
        ("amount", "expected"),
        [
            (95_000, "$95,000.00"),
            (0, "$0.00"),
            (1_234.5, "$1,234.50"),
            (5_000_000, "$5,000,000.00"),
        ],
    )
    def test_amounts_are_unambiguous(self, amount: float, expected: str) -> None:
        assert format_amount(amount) == expected

    def test_is_deterministic(self) -> None:
        # No clock and no randomness: the same request renders byte-identically
        # every time, so a snapshot does not fail at midnight.
        assert rendered(ACT_TWO) == rendered(ACT_TWO)
