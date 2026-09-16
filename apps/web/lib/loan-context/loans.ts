/**
 * The loan files the split screen puts in front of the audience, and what
 * reading one can come back as.
 *
 * Two applications, both named by `DESIGN.md`:
 *
 * - `LN-2291`, Northwind Bakery LLC, $95,000 — acts 2, 3 and 4. Over Alice's
 *   $50,000 authority, carries the fields act 3 redacts, and its
 *   `underwriter_notes` carries act 4's injected instruction.
 * - `LN-2299`, Meridian Physical Therapy, $88,000 — the control. Also over her
 *   authority, without the injection, which is what lets a failed run be read
 *   as "the injection interfered" rather than "the agent broke" (#91).
 *
 * **Both are read through the governed path, as the signed-in person.** There
 * is no direct read of `loans.db` anywhere in `apps/web` and there must never
 * be one: the left half is a client of the bank's API exactly like the agent
 * is, so what it shows is what the control plane allowed through. A screen that
 * reached past the hooks would be showing the audience a loan file the demo's
 * own thesis says it might not be entitled to — and act 3's redaction would be
 * visible in the chat and absent from the file beside it.
 */

/** The applications the shell shows. `DESIGN.md` → Cast, and #91 for the control. */
export const DEMO_LOAN_IDS = ["LN-2291", "LN-2299"] as const;

/**
 * A loan application as the bank's API returns it, as far as this screen reads
 * it.
 *
 * Every field is optional but `loan_id`, because this object crossed a tool
 * call and `/post` is allowed to rewrite what comes back (act 3). A screen that
 * required a field the control plane removed would render nothing at all, which
 * is the one outcome worse than rendering a mask.
 *
 * `bank_account_number` and `tax_id` are deliberately **not** in this type. The
 * loan API returns them, they are act 3's subject, and this panel has no reason
 * to put a borrower's account number on a projector.
 */
export interface LoanFile {
  loan_id: string;
  borrower_name?: string;
  status?: string;
  purpose?: string;
  submitted_at?: string;
  underwriter_notes?: string;
  /**
   * The numbers, which may arrive as strings.
   *
   * `/post` rewrites a field's value without changing its name (act 3), and a
   * mask is text whatever the field used to hold. Typing these as `number`
   * alone would make the redacted case a type error in the one direction this
   * screen must survive, so the renderer formats a number and prints a string
   * exactly as it was handed one.
   */
  amount?: number | string;
  credit_score?: number | string;
  annual_revenue?: number | string;
  years_in_business?: number | string;
}

/**
 * What one governed read produced.
 *
 * The same four outcomes the chat stream distinguishes (`lib/agent/events.ts`),
 * and for the same reason: a denial, a missing credential and a broken pipe are
 * three different claims about the world, and this panel may not merge them. A
 * loan file that failed to load because the loan API was down must not appear
 * on screen as one the reader was not allowed to see.
 */
export type LoanRead =
  | { loan_id: string; outcome: "read"; loan: LoanFile }
  /** A hook decided. `reason` is the rule's own words; `ref` is its audit row (#6). */
  | { loan_id: string; outcome: "denied"; reason: string; ref: string | null }
  /** Layer 2: a credential is missing. No hook fired and no audit row exists. */
  | { loan_id: string; outcome: "authorization"; url?: string; instructions?: string }
  /** Plumbing. Nothing decided anything. */
  | { loan_id: string; outcome: "fault"; message: string };

/** What the page produced when it got far enough to try. */
export interface LoanContextBody {
  /** One entry per id in {@link DEMO_LOAN_IDS}, in that order. */
  reads: LoanRead[];
  /** The person every read was made as — this browser's session, never a parameter. */
  actor: string;
  /** The tool the reads went through, as the wire spells it: `Loan_GetLoan`. */
  tool: string;
}

/** What it produced when it could not get that far. */
export interface LoanContextRefusal {
  error: string;
  /** Where the reader has to go, when there is somewhere. Rendered as a link. */
  action?: "signin" | "gateway";
  detail?: unknown;
}

/**
 * What the left half draws, and the only thing that crosses to the browser.
 *
 * Two states, not three. Until #109 there was a `loading` one, because the
 * files were fetched from the browser after the page had already rendered; they
 * are read in the server component now, on the same gateway session that lists
 * the persona's tools, so by the time this type exists the reads have happened.
 * A spinner for a fetch nobody makes is a picture of work that is not being
 * done.
 *
 * Lives here, in the module that depends on nothing, because both sides need
 * it: `lib/home/surface.ts` builds one on the server and
 * `components/bank/LoanFiles.tsx` renders it in the browser.
 */
export type LoanFilesState =
  | { status: "loaded"; body: LoanContextBody }
  | { status: "refused"; refusal: LoanContextRefusal };

/**
 * The loan file out of whatever one `tools/call` returned.
 *
 * Two shapes, both real. `@mastra/mcp` returns `structuredContent` when the
 * server sends one — which is the plain object — and otherwise hands back the
 * whole MCP result, whose `content` array carries the same JSON as text. The
 * gateway stand-in sends both; real Arcade's toolkits are not measured here for
 * the structured form, so the text path is not defensive padding.
 *
 * Returns `null` rather than guessing when neither shape yields an object with
 * a `loan_id`. A panel that rendered an empty card would be indistinguishable
 * from one whose read was refused.
 */
export function loanFromToolResult(value: unknown): LoanFile | null {
  const direct = asLoan(value);
  if (direct) return direct;

  if (typeof value === "object" && value !== null) {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined;
        if (typeof text !== "string") continue;
        try {
          const parsed = asLoan(JSON.parse(text));
          if (parsed) return parsed;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

function asLoan(value: unknown): LoanFile | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.loan_id !== "string" || body.loan_id.trim() === "") return null;

  return {
    loan_id: body.loan_id,
    ...pickString(body, "borrower_name"),
    ...pickNumber(body, "amount"),
    ...pickString(body, "status"),
    ...pickString(body, "purpose"),
    ...pickString(body, "submitted_at"),
    ...pickNumber(body, "credit_score"),
    ...pickNumber(body, "annual_revenue"),
    ...pickNumber(body, "years_in_business"),
    ...pickString(body, "underwriter_notes"),
  };
}

/**
 * A string field, kept whatever it says.
 *
 * Not validated beyond its type on purpose: after `/post` a field may hold a
 * mask rather than a value (act 3), and a panel that dropped anything that did
 * not look like the original would hide the redaction that is the point.
 */
function pickString(body: Record<string, unknown>, key: keyof LoanFile): Partial<LoanFile> {
  const value = body[key];
  return typeof value === "string" ? ({ [key]: value } as Partial<LoanFile>) : {};
}

function pickNumber(body: Record<string, unknown>, key: keyof LoanFile): Partial<LoanFile> {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return { [key]: value } as Partial<LoanFile>;
  // A masked number arrives as a string. Kept as the string it is, for the same
  // reason `pickString` keeps one: the mask is information.
  if (typeof value === "string" && value.trim() !== "") return { [key]: value } as Partial<LoanFile>;
  return {};
}
