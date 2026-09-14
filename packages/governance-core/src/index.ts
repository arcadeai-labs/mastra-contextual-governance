/**
 * The governance layer: hook framework, policy engine, redaction, audit,
 * event bus. Deliberately free of any business-domain vocabulary, and —
 * enforced by `test/no-app-dependencies.test.ts` — of any dependency on
 * `apps/*`. Swapping the domain means replacing the governed app, never
 * touching this.
 *
 * The types live one layer down in `@cg/policy-schema` (#5) so that the apps,
 * the UI and this package all agree on one definition. Re-exported here for
 * convenience; `@cg/policy-schema` remains the single source.
 *
 * The four pure modules: #7 (PolicyEngine, `./policy-engine.ts`), #8
 * (RedactionEngine, `./redaction-engine.ts`), #9 (ApproverRouter,
 * `./approver-router.ts`) and #10 (GrantChecker, `./grant-checker.ts`).
 *
 * Plus one that holds state without doing I/O: the event bus (#20,
 * `./event-bus.ts`), a subscriber registry the audit write fans out through.
 * It stops at the edge of the process — the socket, the frames and the replay
 * are `apps/hooks`, because HTTP does not belong in here.
 */
import { type Decision } from "@cg/policy-schema";

export {
  Decision,
  Effect,
  GovernanceEvent,
  GRANT_REJECTION_KINDS,
  GrantRejectionReason,
  HookPoint,
  RedactionRecord,
  RedactionStrategy,
} from "@cg/policy-schema";

export {
  attestGrantValidated,
  compilePolicy,
  evaluatePermission,
  governedToolkits,
  hiddenTools,
  NO_REMEDIATION,
  PolicyCompileError,
  renderReason,
  resolveVisibility,
  type CompiledPolicy,
  type PermissionInput,
  type Policy,
  type SubjectOrUnknown,
  type ToolCatalogue,
  type ToolRef,
  type ValidatedGrant,
  type VisibilityDecision,
} from "./policy-engine.ts";

export {
  checkGrant,
  consumeGrant,
  describeGrantRejection,
  isGrantRejection,
  selectGrant,
  type GrantCheck,
  type GrantCheckResult,
  type GrantRejection,
  type GrantSelection,
} from "./grant-checker.ts";

export {
  compileOutputPolicy,
  OutputPolicyCompileError,
  redact,
  type CompiledOutputPolicy,
  type OutputPolicy,
  type RedactionInput,
  type RedactionResult,
} from "./redaction-engine.ts";

export { routeApproval, type RoutingResult } from "./approver-router.ts";

export {
  createEventBus,
  type EventBus,
  type EventBusOptions,
  type EventBusSubscriber,
  type PublishedEvent,
} from "./event-bus.ts";

/**
 * Arcade calls hooks over the public internet, so an outage must degrade to
 * denial rather than to open access (PRD user story 24). Hooks declare their
 * failure mode explicitly — spike #2 measured that there is no default to
 * inherit: `failure_mode` is a required field.
 */
export const FAIL_CLOSED: Decision = {
  effect: "deny",
  reason: "Governance hook unavailable; failing closed.",
  rule_id: null,
};
