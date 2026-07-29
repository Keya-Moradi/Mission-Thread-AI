import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceResult } from "@missionthread/core";

// §16: every result must stay under this ceiling, use deterministic
// property ordering where practical, and never contain a raw database
// error, stack trace, prompt, untrusted event text, or secret.
export const MCP_OUTPUT_BYTE_LIMIT = 32_000;

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function safeErrorResult(message: string, entityType?: string, entityId?: string): CallToolResult {
  const parts = [message];
  if (entityType) parts.push(`(record type: ${entityType})`);
  if (entityId) parts.push(`(record id: ${entityId})`);
  return textResult(parts.join(" "), true);
}

/**
 * Converts a successful ServiceResult's data into the MCP text-content
 * format, enforcing the output byte ceiling. A result that would exceed the
 * ceiling is withheld entirely (never truncated mid-JSON, which could
 * silently produce invalid JSON for the caller) and reported as a safe
 * error instead.
 */
function successResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, "utf8") > MCP_OUTPUT_BYTE_LIMIT) {
    return safeErrorResult(
      "The tool result exceeded the maximum output size and was withheld. Narrow the request (e.g. a lower maxDepth) and try again.",
    );
  }
  return textResult(text);
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
 * Prisma error text").
 */
export async function runTool<T>(fn: () => Promise<ServiceResult<T>>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return toToolResult(result);
  } catch {
    return safeErrorResult("An unexpected error occurred while handling this tool call.");
  }
}
