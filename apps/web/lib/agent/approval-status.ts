/**
 * `GET /api/approvals/{id}/status` — "has this been decided yet?", for a
 * browser whose stream was down when it was.
 *
 * ## Why it exists at all
 *
 * The resume is driven by `event: approval` on the governance stream, and that
 * frame carries no `id:` and takes no part in the replay — it is not an audit
 * row. So it is live-only: a browser disconnected at the moment of the decision
 * never sees it, and the issue names the conditions under which that will
 * happen on stage. This is the catch-up, asked once per reconnect, for the one
 * request that browser is waiting on.
 *
 * ## What it is careful about
 *
 * **It adds no authority.** It is a read. Whether anyone may *decide* is a
 * `/pre` decision on `Approvals.Decide`, settled when a button is pressed, and
 * nothing here goes near it.
 *
 * **It answers about your own request and nothing else.** `GET /approvals/{id}`
 * on the control plane deliberately has nowhere to put a viewer — the approval
 * page is built on the link carrying an opaque id and no capability, and that
 * is what makes the link safe to send in a conversation the requester can read.
 * This route is the opposite kind of thing: it is not a page anybody may open,
 * it is a browser asking about a turn it is holding, so it answers only when
 * the record's requester is the persona signed in on this browser, and answers
 * `404` otherwise — the same answer an id that names nothing gets, so a caller
 * cannot learn which ids exist by the difference.
 *
 * **It returns a status, not a record.** The resume reads the record itself,
 * server-side, and builds every word it asserts from that (`resume.ts`). This
 * says only whether there is now something to resume on.
 */
import { fetchApproval } from "../approvals-store.ts";
import { readIdentitySurface, readWebConfig, type IdentitySurface } from "../config.ts";
import { readSession } from "../identity/session.ts";

export const APPROVAL_STATUS_PREFIX = "/api/approvals";

export interface ApprovalStatusOptions {
  config?: IdentitySurface;
  store?: { hooksHost: string; approvalsStoreToken: string };
}

/** `/api/approvals/{id}/status` → the id, or `null` when the path is not ours. */
export function approvalIdFrom(pathname: string): string | null {
  const match = /^\/api\/approvals\/([^/]+)\/status$/.exec(pathname);
  return match ? decodeURIComponent(match[1] as string) : null;
}

export async function approvalStatus(
  request: Request,
  options: ApprovalStatusOptions = {},
): Promise<Response> {
  const config = options.config ?? readIdentitySurface();
  const id = approvalIdFrom(new URL(request.url).pathname);
  if (id === null) return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const session = await readSession(request, config);
  if (!session) {
    return Response.json({ error: "Nobody is signed in on this browser." }, { status: 401 });
  }

  const store = options.store ?? readWebConfig();
  const lookup = await fetchApproval(id, {
    ...config,
    hooksHost: store.hooksHost,
    approvalsStoreToken: store.approvalsStoreToken,
    approvalsToolkit: config.agent.approvalsToolkit,
  }).catch(() => ({ found: false as const, reason: "the approvals store could not be reached" }));

  // One answer for "no such request" and "not yours", on purpose: two answers
  // would let a caller enumerate ids it has no business knowing about.
  if (
    !lookup.found ||
    lookup.request.requester_id.trim().toLowerCase() !== session.email.trim().toLowerCase()
  ) {
    return Response.json({ error: `No approval request ${id} for this browser.` }, { status: 404 });
  }

  return Response.json(
    { request_id: lookup.request.id, status: lookup.request.status },
    { headers: { "cache-control": "no-store" } },
  );
}
