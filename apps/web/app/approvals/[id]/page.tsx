/**
 * `/approvals/{id}` — the page the Slack link opens.
 *
 * Built on one read, `GET /approvals/{id}`, because the link carries an opaque
 * id and nothing else: no token, no signature, no query string. Whether the
 * person looking may act is not asked here and could not be answered here — it
 * is settled when a button is pressed, by a `/pre` decision on
 * `Approvals.Decide`.
 *
 * **Who the person looking *is* is answered here, and only from the sealed
 * session (#180).** Until this slice the page read `cg_persona` and, with no
 * cookie, fell back to the routed approver — so the opener of a link was
 * assumed to *be* its addressee. That made possession of the link the one thing
 * `grant-checker.ts` says it must never be: permission. `lib/approvals/opener.ts`
 * has the argument; the shape is `/`'s since #176, which is the point.
 *
 * Dynamic, and not by accident: the record changes when somebody decides, and
 * a cached page would show a stale status to the next person to open the link.
 */
import { cookies } from "next/headers";

import { fetchApproval, fetchRoster } from "../../../lib/approvals-store.ts";
import { readOpener } from "../../../lib/approvals/opener.ts";
import { readWebConfig } from "../../../lib/config.ts";
import { decide } from "./actions.ts";
import { DecideControls } from "./controls.tsx";
import { ApprovalPage, UnknownRequest } from "./view.tsx";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = readWebConfig();

  const lookup = await fetchApproval(id, config);
  // An id nobody recognises says so without costing anybody a password: a dead
  // link is a dead link whether or not you are signed in.
  if (!lookup.found) return <UnknownRequest id={id} reason={lookup.reason} />;

  const request = lookup.request;
  const [roster, opener] = await Promise.all([
    fetchRoster(config),
    readOpener(await cookies(), id, config),
  ]);

  return (
    <ApprovalPage
      request={request}
      opener={opener}
      personas={roster}
      controls={
        <DecideControls
          settled={request.status !== "pending"}
          decide={decide.bind(null, id)}
        />
      }
    />
  );
}
