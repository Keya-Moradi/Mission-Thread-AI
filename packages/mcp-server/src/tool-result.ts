import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpEntityIdSchema, type ServiceResult } from "@missionthread/core";

// §16: every result — success, expected error, and unexpected error alike —
// must stay under this ceiling, use deterministic property ordering where
// practical, and never contain a raw database error, stack trace, prompt,
// untrusted event text, or secret.
export const MCP_OUTPUT_BYTE_LIMIT = 32_000;

// A small, fixed literal — never derived from the oversized input it's
// replacing — so falling back to it can never itself produce another
// oversized result.
const OVERSIZED_RESULT_FALLBACK: CallToolResult = {
  content: [
    {
      type: "text",
      text: "The tool result exceeded the maximum output size and was withheld. Narrow the request (e.g. a lower maxDepth) and try again.",
    },
  ],
  isError: true,
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The one central size guard every result — success or error — passes
 * through before being returned. Measures the *actual serialized UTF-8
 * byte length* (not string.length, which undercounts multi-byte
 * characters and escape-sequence expansion) and swaps in the fixed
 * fallback rather than ever truncating text mid-JSON.
 */
function boundedTextResult(text: string, isError: boolean): CallToolResult {
  if (byteLength(text) <= MCP_OUTPUT_BYTE_LIMIT) {
    return { content: [{ type: "text", text }], isError };
  }
  return OVERSIZED_RESULT_FALLBACK;
}

/**
 * An entityId is only ever echoed back to the caller when it independently
 * passes the same mcpEntityIdSchema bound every tool input already enforces
 * — an overlong caller-controlled ID (which should never reach this point
 * in practice, since input validation rejects it first) is silently
 * omitted rather than echoed, as defense in depth.
 */
function safeEntityId(entityId: string | undefined): string | undefined {
  if (entityId === undefined) return undefined;
  return mcpEntityIdSchema.safeParse(entityId).success ? entityId : undefined;
}

function safeErrorResult(message: string, entityType?: string, entityId?: string): CallToolResult {
  const parts = [message];
  if (entityType) parts.push(`(record type: ${entityType})`);
  const safeId = safeEntityId(entityId);
  if (safeId) parts.push(`(record id: ${safeId})`);
  return boundedTextResult(parts.join(" "), true);
}

/**
 * Converts a successful ServiceResult's data into the MCP text-content
 * format. A result that would exceed the byte ceiling is withheld
 * entirely (never truncated mid-JSON, which could silently produce
 * invalid JSON for the caller) and reported as the same fixed safe error
 * every other oversized-result path uses.
 */
function successResult(data: unknown): CallToolResult {
  return boundedTextResult(JSON.stringify(data), false);
}

/**
 * Maps a core ServiceResult<T> to the MCP result format. DomainError.message
 * is documented (packages/core/src/analysis/types.ts) as always safe to
 * display — it is never a raw database error or stack trace — so it is
 * forwarded directly, same as apps/web already does.
 */
export function toToolResult<T>(result: ServiceResult<T>): CallToolResult {
  if (result.ok) return successResult(result.data);
  return safeErrorResult(result.error.message, result.error.entityType, result.error.entityId);
}

/**
 * Wraps a core service call so that any unexpected thrown exception (e.g. a
 * database connection failure) is converted into one fixed, safe message —
 * the exception's own text/stack is discarded, never forwarded to the MCP
 * client (§13: "discard database exception detail"; §16: "Do not expose
 * Prisma error text") — and still passes through the same central byte
 * guard as every other result.
 */
export async function runTool<T>(fn: () => Promise<ServiceResult<T>>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return toToolResult(result);
  } catch {
    return safeErrorResult("An unexpected error occurred while handling this tool call.");
  }
}
