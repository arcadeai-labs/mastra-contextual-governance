/**
 * The Access lane's `/access` decisions, arranged into the cards a room can
 * follow.
 *
 * Two shapes arrive on this lane and they are not the same thing:
 *
 * - **A listing.** One `tools/list` from a persona is answered by several
 *   `/access` calls — four on the deployed gateway
 *   (`apps/hooks/src/access-audit.ts`) — and each of those writes one row per
 *   tool this control plane governs plus, when the call reached past the
 *   catalogue, one summary row (`tool: "*"`, #107). A burst of ten or so
 *   decisions lands in a rush, before the presenter has said anything, and
 *   what the audience is meant to take from it is a single fact: *this is what
 *   that person can see.* That is one card (#156).
 * - **A fan-out.** Arcade calls `/access` once per tool-schema resolution, so
 *   one `tools/call` produces several decisions about the same person and the
 *   same tool. Measured at the #13 sitting with retry off: one
 *   `Loan.GetLoan` produced **three** rows and one `Loan.ApproveLoan` produced
 *   **two** (#64). That is one card per run of repeats, carrying its count —
 *   which is what this module did before #156 and still does.
 *
 * **This is presentation, and only presentation.** Nothing here runs anywhere
 * near `audit_log` or the SSE stream; the raw record stays complete, the
 * timeline still holds every event, and the tallies still count every one of
 * them. A card standing for twelve decisions is a claim that twelve were made,
 * not a claim that one was.
 *
 * ## Which burst is a listing
 *
 * There is no listing correlation id on the wire — `execution_id` is empty for
 * `access`, and Arcade's four calls would not share one even if the hook
 * minted it per call (#156). So the grouping is a window heuristic, and the
 * *label* is drawn from evidence rather than from the heuristic:
 *
 * - the burst carries a **summary row** (`tool: "*"`), which is only ever
 *   written by a call that was asked about tools outside this control plane's
 *   catalogue — a catalogue-wide question, which is what a listing is; or
 * - the burst names **{@link LISTING_TOOL_SPREAD} or more distinct tools**.
 *   A `/access` on a `tools/call` is asked about the one tool being called and
 *   fans out as repeats of it; the widest `tools/call` shape ever measured
 *   here is #13's two successive calls naming two tools between them. Three is
 *   the smallest number that no measured `tools/call` produces, and the local
 *   gateway stand-in's listing names six.
 *
 * A burst that is neither reads as what it is — a run of repeats — and never
 * says `tools/list` on its face. A control surface that labelled a
 * `tools/call` fan-out a listing would be asserting an event that did not
 * happen, which is the failure mode this repo is organised against.
 *
 * ## Three rules the panel would be wrong without
 *
 * - **Only adjacent events group.** Reaching past an intervening event to
 *   merge two that match would reorder the lane, and not reordering is the
 *   timeline's first property (`timeline.ts`): a burst shares timestamps to
 *   the millisecond, and a panel that shuffles a deny past the allow after it
 *   tells the room the opposite of what happened.
 * - **A group spans at most {@link ACCESS_GROUP_WINDOW_MS}**, measured from
 *   its newest member rather than from the previous one. Chaining
 *   neighbour-to-neighbour would let a slow drip of decisions, one every two
 *   seconds for a minute, collapse into a single card claiming they arrived
 *   together.
 * - **A burst is one person's.** `user_id` is the only key a listing can be
 *   grouped on — a listing decides many tools with many outcomes, so tool and
 *   decision cannot be part of it — and two people listing at the same moment
 *   are two cards, never one.
 */
import type { GovernanceEvent, HookPoint } from "@cg/policy-schema";

/**
 * How far apart two access decisions may be and still share a card.
 *
 * Measured where it can be. A listing driven through the local rig —
 * `apps/hooks` with its real policy behind the gateway stand-in,
 * `test/access-listing-live.test.tsx` — answers one `/access` call, and its
 * six decisions share a timestamp: **spread 0 ms**, printed by that suite on
 * every run. The #13 fan-out lands 40 ms apart per decision and 160 ms end to
 * end (`access-fanout.ts`).
 *
 * What the window actually has to cover is the gap between the **four
 * `/access` calls** the deployed gateway makes for one `tools/list`
 * (`apps/hooks/src/access-audit.ts`) — four HTTP round trips to Render, which
 * nothing here can measure. Three seconds is an order of magnitude above every
 * burst that has been measured, comfortably above four round trips, and well
 * under the gap between two things a presenter does. If a deployed listing
 * ever spreads wider than this it draws as several cards rather than one,
 * which is the measured case #156 says to reopen with.
 *
 * One constant, so "a short window" is a number somebody can change once.
 */
export const ACCESS_GROUP_WINDOW_MS = 3_000;

/**
 * How many distinct tools a burst must name before the panel will call it a
 * listing on the face of the card.
 *
 * See the header: a `/access` on a `tools/call` is asked about one tool, the
 * widest measured `tools/call` shape names two across two calls, and a listing
 * names every governed tool — six through the local stand-in, six plus the
 * summary row on the deployed gateway.
 */
export const LISTING_TOOL_SPREAD = 3;

/**
 * The `tool` spelling of the row that stands for everything outside the
 * catalogue (#107). The same string `apps/hooks/src/access-audit.ts` exports
 * as `SUMMARY_TOOL`; it is repeated rather than imported because `apps/web`
 * does not depend on `apps/hooks` and the value is part of the event contract,
 * not of that module.
 */
export const SUMMARY_TOOL = "*";

/**
 * The lanes that group. Only `access` fans out — `/pre` and `/post` are called
 * once per execution, so two adjacent identical rows there are two real
 * attempts and collapsing them would hide the retry that is the whole beat.
 */
export const GROUPED_HOOKS: ReadonlySet<HookPoint> = new Set<HookPoint>(["access"]);

/** One card. Usually one event; sometimes a run of them; sometimes a listing. */
export interface EventRow {
  /**
   * What the card is drawn from: the newest member, so the freshest card
   * still carries the freshest facts. Always `events[0]` — named separately
   * because a non-empty array is not a thing the type system says here.
   */
  readonly event: GovernanceEvent;
  /** Every member, newest first. Length 1 for an ungrouped row. */
  readonly events: readonly GovernanceEvent[];
  /**
   * This row is one person's tool listing, and may say so. False for a run of
   * repeats and for a lone decision. See the header for what counts as
   * evidence.
   */
  readonly listing: boolean;
}

/** One tool a listing hid, and the rule that hid it. */
export interface HiddenTool {
  readonly tool: string;
  readonly rule_id: string | null;
  /** The rule's own words. Shown when there is one denial, quiet when many. */
  readonly reason: string;
}

/** What a listing card states, derived from its members and nothing else. */
export interface ListingFacts {
  /** Whose listing. Every member shares it — that is what grouped them. */
  readonly user_id: string;
  /** Distinct tools left visible, in the order the control plane decided them. */
  readonly enabled: readonly string[];
  /** Distinct tools taken away, each with the rule that took it. */
  readonly hidden: readonly HiddenTool[];
  /**
   * The row standing for everything outside this control plane's catalogue
   * (#107), or `null`. It is a member of the card and is never a card of its
   * own; the card shows its reason instead of pretending it names a tool.
   */
  readonly summary: GovernanceEvent | null;
  /** How many decisions this card stands for, summary row included. */
  readonly decisions: number;
}

/** How many decisions this row stands for. */
export function rowCount(row: EventRow): number {
  return row.events.length;
}

/** Milliseconds, or `NaN` for a timestamp that will not parse. */
function instant(event: GovernanceEvent): number {
  return Date.parse(event.ts);
}

/**
 * Close enough in time to share a card.
 *
 * An unparseable timestamp gives NaN, every comparison against it is false,
 * and the event starts its own row. Refusing to group what we cannot place in
 * time is the safe direction: the worst case is a card the panel could have
 * merged and did not.
 */
function within(newest: GovernanceEvent, event: GovernanceEvent, windowMs: number): boolean {
  return Math.abs(instant(newest) - instant(event)) <= windowMs;
}

/** Adjacent decisions about one person, inside the window. One burst each. */
function burstsByUser(
  events: readonly GovernanceEvent[],
  windowMs: number,
): GovernanceEvent[][] {
  const bursts: GovernanceEvent[][] = [];

  for (const event of events) {
    const open = bursts[bursts.length - 1];
    const joins =
      open !== undefined &&
      open[0] !== undefined &&
      open[0].user_id === event.user_id &&
      within(open[0], event, windowMs);

    if (joins && open !== undefined) open.push(event);
    else bursts.push([event]);
  }

  return bursts;
}

/** The distinct tools a burst names, the summary row excluded — it names none. */
function toolsNamed(burst: readonly GovernanceEvent[]): Set<string> {
  return new Set(
    burst.filter((event) => event.tool !== SUMMARY_TOOL).map((event) => event.tool),
  );
}

/** Whether this burst is evidence of a `tools/list`. See the header. */
function isListing(burst: readonly GovernanceEvent[]): boolean {
  if (burst.some((event) => event.tool === SUMMARY_TOOL)) return true;
  return toolsNamed(burst).size >= LISTING_TOOL_SPREAD;
}

/**
 * A burst that is not a listing, as the #64 rows it was before: adjacent
 * decisions sharing `tool` and `decision` share a card, and two different
 * decisions about one tool stay two cards because that is the interesting
 * case and never a duplicate.
 *
 * The burst is already one person's and already inside the window, so neither
 * needs re-checking here.
 */
function repeatRows(burst: readonly GovernanceEvent[]): EventRow[] {
  const rows: Array<{ event: GovernanceEvent; events: GovernanceEvent[] }> = [];

  for (const event of burst) {
    const open = rows[rows.length - 1];
    const joins =
      open !== undefined && open.event.tool === event.tool && open.event.decision === event.decision;

    if (joins && open !== undefined) open.events.push(event);
    else rows.push({ event, events: [event] });
  }

  return rows.map((row) => ({ ...row, listing: false }));
}

/**
 * `events` — newest first, as a lane holds them — as rows: one card per
 * listing, one card per run of repeats, one card for a lone decision.
 *
 * Every input event comes back out, in the order it went in: flattening the
 * result reproduces `events` exactly. That is the property that makes this
 * grouping rather than de-duplication, and `access-grouping.test.tsx` asserts
 * it directly.
 */
export function groupAccessEvents(
  events: readonly GovernanceEvent[],
  windowMs: number = ACCESS_GROUP_WINDOW_MS,
): EventRow[] {
  return burstsByUser(events, windowMs).flatMap((burst) =>
    isListing(burst)
      ? [{ event: burst[0] as GovernanceEvent, events: burst, listing: true }]
      : repeatRows(burst),
  );
}

/**
 * What a listing card may say, read off its members.
 *
 * Tools are reported **distinct**: the deployed gateway answers one
 * `tools/list` with four `/access` calls, and a tool named by more than one of
 * them is one tool the person can see, not two. A tool that was denied by any
 * member is reported hidden even if another member allowed it — the louder of
 * the two, the same direction `accessAuditRows` takes for its summary row.
 *
 * Order is the order the control plane decided them, which is the reverse of
 * the newest-first order a lane holds, so the names on the card read in the
 * same order as the rows in `audit_log`.
 */
export function listingFacts(row: EventRow): ListingFacts {
  const inOrder = [...row.events].reverse();
  const enabled: string[] = [];
  const hidden: HiddenTool[] = [];
  const hiddenNames = new Set<string>();
  let summary: GovernanceEvent | null = null;

  for (const event of inOrder) {
    if (event.tool === SUMMARY_TOOL) {
      // The newest summary row wins, the same way the card is drawn from its
      // newest member. Four calls can each write one.
      summary = event;
      continue;
    }
    if (event.decision === "deny") {
      if (hiddenNames.has(event.tool)) continue;
      hiddenNames.add(event.tool);
      hidden.push({ tool: event.tool, rule_id: event.rule_id, reason: event.reason });
      continue;
    }
    if (!enabled.includes(event.tool)) enabled.push(event.tool);
  }

  return {
    user_id: row.event.user_id,
    // A tool denied by one call and allowed by another is hidden, and must not
    // also be counted among what the person can see.
    enabled: enabled.filter((tool) => !hiddenNames.has(tool)),
    hidden,
    summary,
    decisions: row.events.length,
  };
}

/** Each event as its own row, for the lanes that do not group. */
function ungrouped(events: readonly GovernanceEvent[]): EventRow[] {
  return events.map((event) => ({ event, events: [event], listing: false }));
}

/**
 * The rows a lane draws. The one place that decides which hook points group,
 * so a lane component never has to.
 */
export function rowsFor(
  hook: HookPoint,
  events: readonly GovernanceEvent[],
  windowMs: number = ACCESS_GROUP_WINDOW_MS,
): EventRow[] {
  return GROUPED_HOOKS.has(hook) ? groupAccessEvents(events, windowMs) : ungrouped(events);
}
