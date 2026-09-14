/**
 * What `app/api/chat/route.ts` actually calls, and why it is not `chat` itself.
 *
 * #92's 500 was not thrown inside `chat()`. It was thrown while Node loaded the
 * module `chat` lives in: `@mastra/core` opens `ws` at module scope, `ws` was
 * not in the standalone image, and the route module never evaluated. A
 * `try`/`catch` inside the handler is reached only after that import succeeds,
 * so it could not have caught the one failure this issue is about.
 *
 * Hence the loader seam. The handler graph — `@mastra/mcp`, `@mastra/core`, the
 * Anthropic provider — is pulled in by a dynamic `import()` inside a `try`, and
 * a module that will not load becomes the same JSON everything else answers
 * with, naming the step. Nothing this file imports can itself fail that way:
 * `fault.ts` imports nothing at all.
 *
 * `load` is injectable for the same reason `ModelFactory` is in `handlers.ts` —
 * a seam a test can drive rather than a mock of the thing under test.
 * `test/chat-fault.test.ts` hands it a loader that throws and reads the
 * response back over real HTTP.
 */
import { serverFault } from "./fault.ts";

/** The part of `handlers.ts` this file needs. Structural, so the real module satisfies it. */
export interface ChatModule {
  chat(request: Request): Promise<Response>;
}

export type LoadChat = () => Promise<ChatModule>;

/** Named here so the test and the response agree without sharing a string literal. */
export const LOAD_STEP = "load the agent handler and its MCP dependencies";
/** The backstop. `chat()` already shapes its own faults; this catches whatever it could not. */
export const RUN_STEP = "run the chat handler";

export async function chatEntry(
  request: Request,
  load: LoadChat = () => import("./handlers.ts"),
): Promise<Response> {
  let handler: ChatModule;
  try {
    handler = await load();
  } catch (cause) {
    return serverFault(LOAD_STEP, cause);
  }

  try {
    return await handler.chat(request);
  } catch (cause) {
    return serverFault(RUN_STEP, cause);
  }
}
