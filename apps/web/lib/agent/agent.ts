/**
 * The agent. Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id
 * from the environment — `DESIGN.md` → Model.
 *
 * ## The system prompt contains no behaviour, in either direction
 *
 * This is the load-bearing decision in the file and it is easy to undo by
 * accident, in both directions, and this slice undid it both ways before round
 * 1 of #88's review pulled it back.
 *
 * Spike #6 measured that a hook's `error_message` crosses to the model verbatim
 * over MCP, and issue #14 draws the conclusion: *"there is no excuse for
 * putting denial-handling instructions in the system prompt. If the model
 * doesn't act on the remediation text, the text is wrong — fix it in #12, not
 * in the prompt."* `DESIGN.md` → Determinism: **the hook writes the remediation
 * instruction, not the system prompt.**
 *
 * Read that as covering *every* nudge about whether and how to act, not only
 * the ones that sound like governance:
 *
 * - **Caution is a model-side control.** An earlier draft said a decision was
 *   "a real, irreversible write … and there is no undo". Claude searched, read
 *   `LN-2291`, and then stopped to ask permission — so `ApproveLoan` was never
 *   called and `/pre` never fired. The demo is an agent that goes ahead and is
 *   stopped by something outside it; an agent that asks first is a model-side
 *   control standing where the hook should be, and `DESIGN.md` → Thesis is an
 *   argument against relying on one.
 * - **So is telling it not to be cautious.** The draft that replaced the above
 *   said "when you have been asked to record a decision … record it. Do not
 *   stop to ask the person to confirm." That reaches the beat — by steering,
 *   which makes the run prove the steering. A prompt that has to push the model
 *   *into* the tool call is as much a thumb on the scale as one that holds it
 *   back, and the review was right to name both.
 *
 * What is left is only what the model could not otherwise know: who it is
 * acting for, what its tools are for, that a request naming a loan by amount
 * can be resolved by searching, and that a report should quote rather than
 * paraphrase. Nothing about refusing, escalating, retrying or confirming.
 * Nothing about whether to make a call at all.
 *
 * One line deserves naming because it is the closest to the edge. *"Quote what
 * a tool gave you rather than paraphrasing it"* is a reporting instruction, not
 * a denial-handling one — it is about fidelity to any tool output, and the
 * prompt never mentions denials, refusals or the control plane. It is the
 * driver's ruling for #88 round 1, phrased so that the word "denial" does not
 * appear: the effect asked for is that a refusal's text reaches the reply
 * unaltered, and the way to get it without teaching the model about refusals is
 * to ask for verbatim reporting of everything.
 *
 * The one thing the prompt still steers is *which application*, and only
 * because #14's demo prompt names it by amount: the first live run answered
 * "could you give me the loan ID", made no tool call, and no hook fired. That
 * is about how a request names a thing, not about what anyone may do to it.
 *
 * Tool *descriptions* are the other place behaviour can hide, and `tools/loan`
 * still says a write has "no undo". Out of scope here and filed as **#90**.
 *
 * ## Temperature 0, and one model id
 *
 * Temperature is pinned at the call site rather than at construction because
 * `modelSettings` is a per-execution option in Mastra and a default set here
 * can be overridden by a caller who does not know it exists. One place, on
 * every run: `run.ts`.
 */
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * What the model is told: role, tools, how a loan gets named, how to report.
 *
 * Read the header before changing it. Every sentence here is a fact the model
 * could not otherwise know; none of them is an instruction about whether or how
 * to act, and adding one — in either direction — is what makes a green run
 * prove the prompt instead of the control plane.
 */
export const INSTRUCTIONS = [
  "You are a loan operations assistant inside a commercial bank's loan origination system.",
  "",
  "You act for the loan officer you are talking to. They are signed in, and every tool call you",
  "make is made as them.",
  "",
  "Your tools read and write the bank's loan book: search it, read one application in full,",
  "and record an approval or a denial on one.",
  "",
  "People name an application the way colleagues do — by amount, by borrower, by what is",
  "outstanding — and rarely by its ID. Search for it rather than asking them to look the ID up.",
  "If more than one matches, say which ones.",
  "",
  "Report what each tool gave you, quoting its own words rather than paraphrasing them.",
].join("\n");

export interface ModelOptions {
  /** `MODEL_ID` — `claude-sonnet-5`. Kept in the environment so it can be swapped without a change here. */
  modelId: string;
  /** `ANTHROPIC_API_KEY`. */
  apiKey: string;
  /**
   * The `fetch` the provider makes its HTTP calls with. Unset in the product,
   * which is the whole point of it being here: #16 has to prove that a redacted
   * field is absent from **the request body that leaves this process**, and the
   * only honest place to read that is the socket. A test passes a wrapper that
   * records the body and delegates; reading the code instead, or reading the
   * rendered chat, would be assuming.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * The language model, or a caller-supplied one.
 *
 * The seam exists for one reason: a suite has to be able to drive the whole
 * governed chain — real control plane, real loan book, real MCP transport —
 * on a machine with no Anthropic key, and separately to drive it with the real
 * model when there is one. Everything downstream of the model is identical in
 * both cases, which is what makes the cheap run worth running.
 */
export type ModelLike = Parameters<typeof buildAgent>[0]["model"];

export function anthropicModel(options: ModelOptions) {
  // `createAnthropic` rather than the default `anthropic` export: the default
  // reads `ANTHROPIC_API_KEY` off `process.env` at call time, and this service
  // reads its environment in exactly one place (`lib/config.ts`).
  return createAnthropic({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })(options.modelId);
}

/** Stable across turns and processes, so a trace names the same agent every time. */
export const AGENT_ID = "loan-operations";

export function buildAgent(options: {
  model: ConstructorParameters<typeof Agent>[0]["model"];
  tools: Record<string, unknown>;
  instructions?: string;
}): Agent {
  return new Agent({
    id: AGENT_ID,
    name: "loan-operations",
    instructions: options.instructions ?? INSTRUCTIONS,
    model: options.model,
    // `exactOptionalPropertyTypes` is on, so the cast has to drop `undefined`
    // rather than widen to it: an optional property may be absent, but it may
    // not be present and undefined.
    tools: options.tools as NonNullable<ConstructorParameters<typeof Agent>[0]["tools"]>,
  });
}
