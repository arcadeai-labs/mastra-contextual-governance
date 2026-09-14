/**
 * Back to a clean rehearsal state: every person, session, token and consent
 * dropped and the four personas seeded again — and **the OAuth client left
 * exactly as it was**.
 *
 * That last clause is the whole reason this file is careful. Better Auth
 * generates the `client_id` and `client_secret`; they cannot be pinned from
 * env, they live on this disk, and they are typed into the Arcade dashboard by
 * hand when the provider is registered (#13). Rotate them and Arcade goes on
 * holding the old pair, OAuth fails at the authorize step — which Arcade
 * evaluates *before* `/pre`, so no hook fires, no audit row is written and the
 * panel simply stays dark. There is no screen anywhere that says "your IdP
 * credentials rotated", and it would happen minutes before presenting.
 *
 * `resetPeople` never touches `oauthClient` or `jwks`, so this should be
 * impossible. It is asserted anyway, on both sides of the delete, because #23
 * owns not trusting the other slice: the client ids are read before, read
 * again after, and a difference is an error rather than a line in a log
 * somebody might scroll past.
 *
 * One implementation, two callers: `scripts/reset.ts` for a shell on the
 * service, and `POST /admin/reset` for `bun run reset` at the repo root, which
 * has no shell to run anything in.
 */
import type { Database } from "bun:sqlite";

import type { Auth } from "./auth.ts";
import { ensureOAuthClients } from "./client.ts";
import type { OAuthClientSpec } from "./config.ts";
import { countPeople, resetPeople } from "./db.ts";

export const RESET_PATH = "/admin/reset";

export interface IdpResetResult {
  people: { before: number; after: number };
  /** Every configured client, by key, with the id that must not have moved. */
  clients: { key: string; client_id: string }[];
}

/**
 * The one outcome that costs a human a re-registration in the Arcade
 * dashboard. Its own class so a caller can tell it from a database error and
 * say the right thing: this is not "the reset failed", it is "the reset
 * succeeded and the registration Arcade holds is now stale".
 */
export class OAuthClientRotatedError extends Error {
  constructor(readonly rotations: { key: string; was: string; now: string }[]) {
    super(
      `OAuth client${rotations.length > 1 ? "s" : ""} ROTATED during reset: ` +
        rotations.map((each) => `"${each.key}" ${each.was} -> ${each.now}`).join(", ") +
        ". The Arcade cg-idp provider registration is now stale and must be re-registered; " +
        "authorization will fail before any hook runs, so nothing on the panel will say why.",
    );
    this.name = "OAuthClientRotatedError";
  }
}

export interface IdpResetDeps {
  db: Database;
  auth: Auth;
  clients: OAuthClientSpec[];
  secret: string;
}

/**
 * Reconcile the clients, clear the people, reconcile again, compare.
 *
 * The reconcile runs on both sides rather than only reading the rows: it is
 * what the service does at boot, so a client that somehow went missing is
 * recreated here too — and if it was recreated, its id moved, and the
 * comparison below is exactly the alarm that should sound.
 */
export async function runIdpReset(deps: IdpResetDeps): Promise<IdpResetResult> {
  const { db, auth, clients, secret } = deps;
  const ensure = () => ensureOAuthClients(auth, { clients, secret });

  const before = await ensure();
  const peopleBefore = countPeople(db);
  await resetPeople(db);
  const after = await ensure();

  // Every configured client, not just the first: a second registration is as
  // stale as the first if its id moved, and it fails in the same invisible
  // place.
  const rotations = before.flatMap((was, index) => {
    const now = after[index]!;
    return was.clientId === now.clientId ? [] : [{ key: was.key, was: was.clientId, now: now.clientId }];
  });
  if (rotations.length > 0) throw new OAuthClientRotatedError(rotations);

  return {
    people: { before: peopleBefore, after: countPeople(db) },
    clients: after.map((each) => ({ key: each.key, client_id: each.clientId })),
  };
}

/** The line both callers print, so a shell run and an HTTP run read alike. */
export function resetSummary(dbPath: string, result: IdpResetResult): string {
  return (
    `reset ${dbPath}: ${result.people.after} people re-seeded, ` +
    `OAuth client${result.clients.length > 1 ? "s" : ""} ` +
    `${result.clients.map((each) => each.client_id).join(", ")} unchanged`
  );
}
