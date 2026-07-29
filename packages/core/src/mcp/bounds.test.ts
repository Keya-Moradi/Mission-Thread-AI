import { describe, expect, it } from "vitest";
import { mcpEntityIdSchema } from "./schemas";
import { boundMcpText, MCP_LIMITS } from "./types";

describe("mcpEntityIdSchema — pure, no database", () => {
  it("[valid ID] a normal seed-format ID passes", () => {
    expect(mcpEntityIdSchema.safeParse("REQ-001").success).toBe(true);
  });

  it("[padded] a leading/trailing-whitespace ID is rejected", () => {
    expect(mcpEntityIdSchema.safeParse(" REQ-001 ").success).toBe(false);
  });

  it("[empty] an empty string is rejected", () => {
    expect(mcpEntityIdSchema.safeParse("").success).toBe(false);
  });

  it("[whitespace-only] a whitespace-only string is rejected", () => {
    expect(mcpEntityIdSchema.safeParse("   ").success).toBe(false);
  });

  it("[exactly at the bound] an ID of exactly maxIdLength characters passes", () => {
    expect(mcpEntityIdSchema.safeParse("A".repeat(MCP_LIMITS.maxIdLength)).success).toBe(true);
  });

  it("[one over the bound] an ID of maxIdLength + 1 characters is rejected", () => {
    const result = mcpEntityIdSchema.safeParse("A".repeat(MCP_LIMITS.maxIdLength + 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      // The rejection message is a fixed literal, never the received value
      // — a caller-supplied 129-character (or one-million-character) ID
      // can never leak into a Zod issue message for this schema.
      expect(result.error.issues.map((i) => i.message).join("; ")).not.toContain("A".repeat(50));
    }
  });

  it("[one million characters] an extreme oversized ID is rejected instantly, with a fixed message that never echoes the value", () => {
    const huge = "Z".repeat(1_000_000);
    const result = mcpEntityIdSchema.safeParse(huge);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("; ");
      expect(message).not.toContain(huge);
      expect(message.length).toBeLessThan(500);
    }
  });
});

describe("boundMcpText — pure, no database", () => {
  it("[short text] passes through unchanged", () => {
    expect(boundMcpText("EdgeLink-X")).toBe("EdgeLink-X");
  });

  it("[exactly at the bound] text of exactly maxTextLength characters is unchanged", () => {
    const exact = "a".repeat(MCP_LIMITS.maxTextLength);
    expect(boundMcpText(exact)).toBe(exact);
    expect(boundMcpText(exact).length).toBe(MCP_LIMITS.maxTextLength);
  });

  it("[oversized text] text longer than maxTextLength is deterministically truncated to exactly the bound", () => {
    const oversized = "b".repeat(MCP_LIMITS.maxTextLength + 500);
    const bounded = boundMcpText(oversized);
    expect(bounded.length).toBe(MCP_LIMITS.maxTextLength);
    expect(bounded).toBe("b".repeat(MCP_LIMITS.maxTextLength));
  });

  it("[deterministic] repeated calls on the same input produce the identical result", () => {
    const oversized = "c".repeat(MCP_LIMITS.maxTextLength + 37);
    expect(boundMcpText(oversized)).toBe(boundMcpText(oversized));
  });

  it("[surrogate-pair safety] never splits an astral character (e.g. an emoji) mid-code-unit", () => {
    // One emoji per unit, sized so the cut would otherwise land exactly
    // between the two UTF-16 code units of the final character.
    const emojiText = "😀".repeat(MCP_LIMITS.maxTextLength / 2 + 10);
    const bounded = boundMcpText(emojiText);
    // A valid string never contains an unpaired surrogate.
    expect(bounded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
