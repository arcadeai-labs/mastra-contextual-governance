/**
 * The one shape `POST /api/chat` answers with when something threw that nobody
 * anticipated.
 *
 * `handlers.ts` has four deliberate refusals — 503, 400, 401, 502 — and each
 * says what to do about itself. This is the fifth case and it is different in
 * kind: nothing decided anything, the code simply broke. #92 is what it costs
 * when that arrives bare. On Render, `POST /api/chat` answered Next's stock 500
 * HTML page, the browser rendered *"The chat route answered 500."*, and the
 * only place the cause existed was a Render log line a human had to go and
 * paste into the issue. Three reviewers had passed the same build.
 *
 * So the contract here is: **say which step broke, in the response**. The step
 * name is the difference between "the chat route is down" and "the chat route
 * could not load its own module", and those two have different fixes.
 *
 * `detail` is a **string array** because that is what `components/chat/Chat.tsx`
 * renders (`detailOf` joins arrays and drops everything else), and the same
 * array is what the four refusals already pass. One failure shape, one renderer.
 *
 * This module imports nothing. It is loaded by the route adapter *before* the
 * handler and its `@mastra/*` graph, which is the whole point — a shaper that
 * could itself fail to load would have nothing to say about a module that
 * failed to load.
 */

/** What the response says, so a test can assert on the sentence rather than a substring of it. */
export function faultMessage(step: string): string {
  return `The chat route failed before it could stream, while it tried to ${step}.`;
}

/** `TypeError: x is not a function`, or the value itself when it is not an Error. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * A JSON 500 naming the step, and the stack on stderr.
 *
 * The stack is logged rather than returned: it names paths inside the image and
 * a browser has no use for it, but the Render log is where whoever is on the
 * other end of a failed rehearsal will look next.
 */
export function serverFault(step: string, cause: unknown): Response {
  console.error(`[chat] threw while it tried to ${step}:`, cause);
  return Response.json(
    { error: faultMessage(step), detail: [`step: ${step}`, describeCause(cause)] },
    { status: 500 },
  );
}
