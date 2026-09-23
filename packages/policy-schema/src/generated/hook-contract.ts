// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
//
// Source: ArcadeAI/schemas · logic_extensions/http/1.0/schema.yaml
//         vendored at packages/policy-schema/vendor/ (see vendor/README.md for
//         the pinned commit), spec version 1.1.1-beta.
// Regenerate: bun run --cwd packages/policy-schema generate
//
// Every object is `.passthrough()`: this is a beta contract that Arcade extends
// without notice, and silently stripping a new field on the way into the audit
// log is worse than carrying one we do not understand.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Version of the upstream OpenAPI document these schemas were generated from. */
export const HOOK_CONTRACT_VERSION = "1.1.1-beta";

/**
 * Default paths, by operation. Upstream is explicit that every path is
 * configurable per extension, so these are a starting point, not a contract —
 * whatever `apps/hooks` mounts must match what is registered in Arcade.
 */
export const HOOK_ENDPOINT_PATHS = {
  preHook: "/pre",
  postHook: "/post",
  accessHook: "/access",
  healthCheck: "/health",
} as const;

/** Classification metadata for a tool */
export const ToolClassification = z
  .object({
    /**
     * Service domains this tool interfaces with (e.g., "crm", "email", "calendar").
     * Sourced from the tool's Classification.ServiceDomains metadata. See
     * https://docs.arcade.dev/en/guides/create-tools/tool-basics/add-tool-metadata for
     * valid values.
     */
    service_domains: z.array(z.string()).optional(),
  })
  .passthrough();
export type ToolClassification = z.infer<typeof ToolClassification>;

/** Behavior metadata for a tool */
export const ToolBehavior = z
  .object({
    /**
     * Operations this tool performs (e.g., "read", "create", "update", "delete",
     * "opaque"). Sourced from the tool's Behavior.Operations metadata. See
     * https://docs.arcade.dev/en/guides/create-tools/tool-basics/add-tool-metadata for
     * valid values.
     */
    operations: z.array(z.string()).optional(),
    /** Whether the tool only reads data */
    read_only: z.boolean().optional(),
    /** Whether the tool can delete or irreversibly modify data */
    destructive: z.boolean().optional(),
    /** Whether repeated calls with the same inputs produce the same result */
    idempotent: z.boolean().optional(),
    /** Whether the tool can affect state outside its defined outputs */
    open_world: z.boolean().optional(),
  })
  .passthrough();
export type ToolBehavior = z.infer<typeof ToolBehavior>;

/** Tool metadata */
export const ToolVersionInfoMetadata = z
  .object({
    classification: ToolClassification.optional(),
    behavior: ToolBehavior.optional(),
    /** Arbitrary additional metadata (e.g., {"IdP": "entra_id"}) */
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ToolVersionInfoMetadata = z.infer<typeof ToolVersionInfoMetadata>;

/** Tool identification information */
export const ToolInfo = z
  .object({
    /** Tool name */
    name: z.string(),
    /** Toolkit name */
    toolkit: z.string(),
    /** Tool version */
    version: z.string(),
    metadata: ToolVersionInfoMetadata.optional(),
  })
  .passthrough();
export type ToolInfo = z.infer<typeof ToolInfo>;

/** OAuth2 authorization details */
export const OAuth2Details = z
  .object({
    /** OAuth scopes (always available from token response) */
    scopes: z.array(z.string()).optional(),
    /** Access token claims (only present when token is a JWT; absent for opaque tokens) */
    at: z.record(z.string(), z.unknown()).optional(),
    /** User information from oauth2 provider */
    user_info: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type OAuth2Details = z.infer<typeof OAuth2Details>;

/** Authorization information */
export const Authorization = z
  .object({
    /** ID of the OAuth provider */
    provider_id: z.string().optional(),
    oauth2: OAuth2Details.optional(),
  })
  .passthrough();
export type Authorization = z.infer<typeof Authorization>;

/** Tool execution context */
export const ToolContext = z
  .object({
    authorization: z.array(Authorization).optional(),
    /** Required secrets (key only, no values) */
    secrets: z.array(z.string()).optional(),
    /** Arbitrary metadata from tool */
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** User ID for access checks */
    user_id: z.string().optional(),
  })
  .passthrough();
export type ToolContext = z.infer<typeof ToolContext>;

/** Pre-hook request from engine to hook server */
export const PreHookRequest = z
  .object({
    /** Allows tracking requests and responses */
    execution_id: z.string(),
    tool: ToolInfo,
    /** Tool inputs (name -> value) */
    inputs: z.record(z.string(), z.unknown()),
    context: ToolContext,
  })
  .passthrough();
export type PreHookRequest = z.infer<typeof PreHookRequest>;

/** Override execution parameters */
export const PreHookOverride = z
  .object({
    /** Override tool inputs */
    inputs: z.record(z.string(), z.unknown()).optional(),
    /** Override secrets */
    secrets: z.array(z.record(z.string(), z.string())).optional(),
  })
  .passthrough();
export type PreHookOverride = z.infer<typeof PreHookOverride>;

/** Response code from hook server */
export const ResponseCode = z.enum(["OK", "CHECK_FAILED", "RATE_LIMIT_EXCEEDED"]);
export type ResponseCode = z.infer<typeof ResponseCode>;

/** Pre-hook response from hook server to engine */
export const PreHookResult = z
  .object({
    code: ResponseCode,
    /** Error message for the Agent */
    error_message: z.string().optional(),
    override: PreHookOverride.optional(),
  })
  .passthrough();
export type PreHookResult = z.infer<typeof PreHookResult>;

/** Post-hook request from engine to hook server */
export const PostHookRequest = z
  .object({
    /** Allows tracking requests and responses */
    execution_id: z.string(),
    tool: ToolInfo,
    /** Tool inputs (name -> value) */
    inputs: z.record(z.string(), z.unknown()).optional(),
    /** Whether the tool succeeded */
    success: z.boolean().optional(),
    /** The tool's output value (any JSON type — string, number, object, array, etc.) */
    output: z.unknown().optional(),
    /** Status code from the server */
    execution_code: z.string().optional(),
    /** Execution error from the tool call */
    execution_error: z.string().optional(),
    context: ToolContext,
  })
  .passthrough();
export type PostHookRequest = z.infer<typeof PostHookRequest>;

/** Override response parameters */
export const PostHookOverride = z
  .object({
    /** Override the output value (any JSON type — string, number, object, array, etc.) */
    output: z.unknown().optional(),
  })
  .passthrough();
export type PostHookOverride = z.infer<typeof PostHookOverride>;

/** Post-hook response from hook server to engine */
export const PostHookResult = z
  .object({
    code: ResponseCode,
    /** Error message for the Agent */
    error_message: z.string().optional(),
    override: PostHookOverride.optional(),
  })
  .passthrough();
export type PostHookResult = z.infer<typeof PostHookResult>;

/** Authorization requirements for a tool */
export const ToolAuthRequirements = z
  .object({
    /** Provider ID */
    provider_id: z.string().optional(),
    /** Provider type */
    provider_type: z.string().optional(),
    oauth2: z
      .object({
        /** Required scopes */
        scopes: z.array(z.string()).optional(),
      })
      .passthrough().optional(),
  })
  .passthrough();
export type ToolAuthRequirements = z.infer<typeof ToolAuthRequirements>;

/** Required secret definition */
export const SecretRequirement = z
  .object({
    /** Secret name */
    name: z.string(),
  })
  .passthrough();
export type SecretRequirement = z.infer<typeof SecretRequirement>;

/** Requirements for a toolkit (group of tools) */
export const ToolkitRequirements = z
  .object({
    /** Authorization requirements for a tool */
    authorization: z.array(ToolAuthRequirements).optional(),
    /** Required secrets */
    secrets: z.array(SecretRequirement).optional(),
  })
  .passthrough();
export type ToolkitRequirements = z.infer<typeof ToolkitRequirements>;

/** Version-specific information for a tool */
export const ToolVersionInfo = z
  .object({
    requirements: ToolkitRequirements.optional(),
    /** Tool version */
    version: z.string().optional(),
    metadata: ToolVersionInfoMetadata.optional(),
  })
  .passthrough();
export type ToolVersionInfo = z.infer<typeof ToolVersionInfo>;

/** Information about a group of tools */
export const ToolkitInfo = z
  .object({
    /**
     * Map of tool name to array of tool version info (there may be multiple versions
     * of tools)
     */
    tools: z.record(z.string(), z.array(ToolVersionInfo)).optional(),
  })
  .passthrough();
export type ToolkitInfo = z.infer<typeof ToolkitInfo>;

/** Map of a group of tools */
export const Toolkits = z.record(z.string(), ToolkitInfo);
export type Toolkits = z.infer<typeof Toolkits>;

/** Access-hook request from engine to hook server */
export const AccessHookRequest = z
  .object({
    /** User ID */
    user_id: z.string(),
    toolkits: Toolkits,
  })
  .passthrough();
export type AccessHookRequest = z.infer<typeof AccessHookRequest>;

/**
 * Access-hook response from hook server to engine. If 'only' is included, ONLY those
 * are allowed (deny list ignored).
 */
export const AccessHookResult = z
  .object({
    /** If included, ONLY these are allowed (deny list ignored) */
    only: Toolkits.optional(),
    /** Tools to deny (ignored if 'only' is used) */
    deny: Toolkits.optional(),
  })
  .passthrough();
export type AccessHookResult = z.infer<typeof AccessHookResult>;

/** Health check response */
export const HealthResponse = z
  .object({
    /** Health status */
    status: z.enum(["healthy", "degraded", "unhealthy"]).optional(),
  })
  .passthrough();
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Error response from webhook server */
export const ErrorResponse = z
  .object({
    /** Human-readable error message */
    error: z.string().optional(),
    /** Machine-readable error code for programmatic handling */
    code: ResponseCode.optional(),
  })
  .passthrough();
export type ErrorResponse = z.infer<typeof ErrorResponse>;
