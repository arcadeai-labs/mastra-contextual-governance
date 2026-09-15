/**
 * Who is calling. Derived from the bearer token and from nothing else.
 *
 * The API never takes an actor as a parameter: a request body that named its
 * own author would be one the caller could write anything into. Instead the
 * token is presented to the identity provider that issued it, and the email
 * the provider hands back is the actor. That is the same endpoint Arcade
 * itself identifies the user from, so the `user_id` the control plane governs
 * and the actor this service records are the same string by construction.
 *
 * Addresses are case-insensitive, so the one the provider returns is folded to
 * lower case before it is recorded (#58). Two systems that spell the same
 * person `Alice@…` and `alice@…` join on neither, and the
 * decision history would then describe two people where there is one.
 *
 * This is validation, not decision-making: a token either names someone or it
 * does not. What that someone may do is not asked here.
 */
import { z } from "zod";

const userinfoSchema = z.object({ email: z.string().email() }).passthrough();

/**
 * A request that could not be attributed to anyone. 401 when the token is the
 * problem; 503 when the identity provider is, so that an outage upstream
 * reads as an outage and not as every caller's credentials failing at once.
 */
export class ActorError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 503 = 401,
  ) {
    super(message);
  }
}

/** Hosts are HOST-form (see `.env.example`); the consumer adds the scheme. */
function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}

export async function actorFromRequest(request: Request, idpHost: string): Promise<string> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (match === null) throw new ActorError("A bearer token is required.");

  let response: Response;
  try {
    response = await fetch(`${baseUrl(idpHost)}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${match[1]}` },
    });
  } catch {
    throw new ActorError("The identity provider could not be reached.", 503);
  }

  if (!response.ok) throw new ActorError("The identity provider rejected the token.");

  const parsed = userinfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ActorError("The token does not identify an email address.");

  return parsed.data.email.trim().toLowerCase();
}
