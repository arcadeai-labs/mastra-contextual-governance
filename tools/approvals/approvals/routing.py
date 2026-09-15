"""Minimum-sufficient-clearance approver routing, in Python.

A parity port of `packages/governance-core/src/approver-router.ts` (#9). Two
implementations of one rule in two languages is a real divergence risk, so
neither side is argued to agree with the other: both read
`packages/policy-schema/contract/approver-routing-cases.json` and are checked
against the same rows. `tests/test_routing.py` is that check on this side.

The rule, in words — the same four lines the TypeScript carries:

  1. Drop the requester. Always, even when their own clearance would cover the
     amount. Separation of duties is not a function of authority level.
  2. Drop everyone whose clearance is below the amount. Clearance is a ceiling,
     so a clearance *equal* to the amount is sufficient.
  3. Of those left, pick the lowest clearance. A $95K request with Charlie at
     $250K and Michael at $5M goes to Charlie; not bothering the chief credit
     officer for a mid-size decision is the point.
  4. Tie-break equal clearances by `user_id`, ascending, as plain strings.

Having nobody eligible is an ordinary outcome, not an error and not a quiet
fallback to the highest authority: the caller gets a value it can branch on.

Two notes the TypeScript's parity comment asks this side to hold to. Python
orders strings by code point and JavaScript by UTF-16 code unit; the two agree
across the Basic Multilingual Plane, which covers every address either roster
will ever hold. And sufficiency is `>=`, mirroring `exceeds_clearance`, which
denies only when the input is strictly greater than the clearance.

The model never makes this choice. It is a pure, total function of its inputs,
so the same request always lands on the same desk and the audit trail can say
why.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = ["RoutingResult", "Subject", "route_approval"]


@dataclass(frozen=True)
class Subject:
    """The identity a decision is made about, as the control plane knows it.

    The same shape as `@cg/policy-schema`'s `Subject`. `clearance` is a
    unit-free numeric ceiling: routing compares numbers and never learns what
    the number counts.
    """

    user_id: str
    display_name: str
    role: str
    clearance: float
    attributes: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Subject":
        """Build one from a JSON object, as the roster arrives over the wire."""
        return cls(
            user_id=str(raw["user_id"]),
            display_name=str(raw.get("display_name", "")),
            role=str(raw.get("role", "")),
            clearance=float(raw["clearance"]),
            attributes=dict(raw.get("attributes") or {}),
        )


@dataclass(frozen=True)
class RoutingResult:
    """The routing decision. Discriminate on `outcome`."""

    outcome: Literal["routed", "no_eligible_approver"]
    #: The one person who will be asked, or None when nobody is eligible.
    approver: Subject | None
    #: Everyone who *could* have approved, lowest clearance first; the approver
    #: is `candidates[0]`. Recorded so the panel can show who was deliberately
    #: not bothered. Always empty when nobody is eligible.
    candidates: tuple[Subject, ...]
    #: The bar a candidate had to clear: the amount itself.
    required_clearance: float


def route_approval(
    amount: float,
    requester_id: str,
    roster: list[Subject] | tuple[Subject, ...],
) -> RoutingResult:
    """Route `amount` to the lowest sufficient approver in `roster`, excluding `requester_id`.

    Args:
        amount: The numeric input being escalated, in `Subject.clearance`'s
            unit-free scale. Must be a finite, non-negative number.
        requester_id: `Subject.user_id` of whoever made the blocked call.
        roster: Every subject the control plane knows about. Not mutated.

    Raises:
        ValueError: when `amount` is negative, NaN or infinite. That is a
            programming error upstream, not a routing outcome, and must not be
            confused with "nobody can approve this". (The TypeScript raises
            `RangeError`, which is what Python spells `ValueError`.)
    """
    if not math.isfinite(amount) or amount < 0:
        raise ValueError(
            f"route_approval: amount must be a finite, non-negative number; got {amount!r}"
        )

    candidates = tuple(
        sorted(
            (
                subject
                for subject in roster
                if subject.user_id != requester_id and subject.clearance >= amount
            ),
            key=lambda subject: (subject.clearance, subject.user_id),
        )
    )

    if not candidates:
        return RoutingResult(
            outcome="no_eligible_approver",
            approver=None,
            candidates=(),
            required_clearance=amount,
        )
    return RoutingResult(
        outcome="routed",
        approver=candidates[0],
        candidates=candidates,
        required_clearance=amount,
    )
