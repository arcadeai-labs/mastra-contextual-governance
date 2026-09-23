/**
 * The frozen contract every other slice builds against.
 *
 * Two sources, kept apart on purpose:
 *
 * - `./generated/hook-contract.ts` — Arcade's webhook payloads, generated from
 *   the OpenAPI document in `ArcadeAI/schemas`. Not hand-written, so our idea
 *   of the contract cannot drift from the real one. Regenerate with
 *   `bun run --cwd packages/policy-schema generate`.
 * - `./domain.ts` — our own governance vocabulary. Hand-written, and
 *   domain-agnostic: subjects, rules, decisions, grants, events. Nothing in
 *   here knows what the governed system does.
 *
 * `./fixtures.ts` builds valid instances of both, for tests and for the UI lane
 * working against a control plane that is not running yet.
 *
 * Zod 4, pinned to one exact version at the repo root (#187).
 */
import type { z } from "zod";

import type {
  ApprovalRecord as ApprovalRecordSchema,
  ApprovalRequest as ApprovalRequestSchema,
  Grant as GrantSchema,
  OutputRule as OutputRuleSchema,
  PolicyRule as PolicyRuleSchema,
  Subject as SubjectSchema,
} from "./domain.ts";

export {
  ApprovalNotice,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
  Condition,
  ConditionOperator,
  Decision,
  Effect,
  FieldRedaction,
  GovernanceEvent,
  Grant,
  GRANT_REJECTION_KINDS,
  GrantRejectionReason,
  HookPoint,
  Inputs,
  OutputRule,
  PatternRedaction,
  PolicyRule,
  RedactionKind,
  RedactionRecord,
  RedactionStrategy,
  Subject,
  SubjectMatcher,
  Timestamp,
  ToolMatcher,
} from "./domain.ts";

export {
  AccessHookRequest,
  AccessHookResult,
  Authorization,
  ErrorResponse,
  HealthResponse,
  HOOK_CONTRACT_VERSION,
  HOOK_ENDPOINT_PATHS,
  OAuth2Details,
  PostHookOverride,
  PostHookRequest,
  PostHookResult,
  PreHookOverride,
  PreHookRequest,
  PreHookResult,
  ResponseCode,
  SecretRequirement,
  ToolAuthRequirements,
  ToolBehavior,
  ToolClassification,
  ToolContext,
  ToolInfo,
  ToolkitInfo,
  ToolkitRequirements,
  Toolkits,
  ToolVersionInfo,
  ToolVersionInfoMetadata,
} from "./generated/hook-contract.ts";

export * from "./fixtures.ts";

/**
 * Author-facing shapes: what you write in a seed file or a policy editor,
 * before Zod fills in the defaults.
 *
 * `z.infer` gives the *output* type, where `enabled`, `priority`, `conditions`
 * and friends are all present because `parse()` supplied them. Seed data should
 * not have to spell those out, so anything that authors policy — the seeder,
 * the live rule editor — types its literals as these and lets `parse()` do the
 * rest.
 */
export type SubjectInput = z.input<typeof SubjectSchema>;
export type PolicyRuleInput = z.input<typeof PolicyRuleSchema>;
export type OutputRuleInput = z.input<typeof OutputRuleSchema>;
export type GrantInput = z.input<typeof GrantSchema>;
export type ApprovalRequestInput = z.input<typeof ApprovalRequestSchema>;
export type ApprovalRecordInput = z.input<typeof ApprovalRecordSchema>;
