"use server";

/**
 * The one server action the approval page needs, and nothing else.
 *
 * `decide` is the whole security claim of this slice in one function: it reads
 * the identity from **the sealed session** *on the server*, and then makes an
 * ordinary Arcade tool call as that person. It does not write to
 * `governance.db`, it does not call the approvals store, and it has no branch
 * that records a decision when Arcade refuses. Every path to a recorded
 * decision goes through `/pre`.
 *
 * The note and the decision come from the form; the actor does not. An actor
 * the browser could post is an actor the browser could choose, and the whole
 * demo turns on the actor being something the caller cannot write.
 *
 * **`cg_persona` is gone (#180), and so is the routed-approver fallback it hid
 * behind.** The cookie let the browser name the account a decision was made
 * under, and its *default* — no cookie at all — named the routed approver, so
 * the requester opening her own link decided as the person the request had been
 * routed to. This function now has exactly one source for `user_id` and no
 * fallback: whoever the IdP said signed in, or nobody.
 *
 * Signing in is not a permission either. A session only supplies a name; `/pre`
 * is still what says whether that person may decide this request, and
 * `pre.decide-not-by-the-requester` is what refuses the requester now that it
 * is finally asked about her.
 */
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { readWebConfig } from "../../../lib/config.ts";
import { readOpener } from "../../../lib/approvals/opener.ts";
import { submitDecision, type DecideResult } from "../../../lib/decide.ts";

export async function decide(
  requestId: string,
  _previous: DecideResult,
  form: FormData,
): Promise<DecideResult> {
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "denied") {
    return { state: "failed", message: "No decision was submitted." };
  }

  const config = readWebConfig();
  const opener = await readOpener(await cookies(), requestId, config);
  if (opener.state === "signed-out") {
    // A fault, not a refusal, and the wording matters: no control has spoken,
    // because there was no identity to ask a control about. Rendering this as a
    // denial would put a refusal on screen that the control plane never made.
    return {
      state: "failed",
      message:
        "This browser is not signed in, so there is nobody to make this decision as. " +
        "Sign in and open the link again — nothing was sent to the control plane.",
    };
  }

  const noteField = form.get("note");
  const note = typeof noteField === "string" && noteField.trim().length > 0 ? noteField.trim() : null;

  const result = await submitDecision(
    { userId: opener.email, requestId, decision, note },
    config,
  );
  // Re-read on the way out so a recorded decision is reflected in the details
  // above the buttons, and a refusal visibly leaves them alone.
  revalidatePath(`/approvals/${requestId}`);
  return result;
}
