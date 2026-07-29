import { describe, expect, it } from "vitest";
import { notFound, ok, validationError, type ServiceResult } from "@missionthread/core";
import { runTool, toToolResult, MCP_OUTPUT_BYTE_LIMIT } from "./tool-result";

function textOf(result: { content: unknown; isError?: boolean }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return content[0]!.text;
}

describe("tool-result — the central byte-ceiling guard covers both success and error paths", () => {
  it("[oversized success] withholds the payload and falls back to a small fixed error, never a truncated/invalid JSON fragment", () => {
    const oversized = ok({ blob: "x".repeat(MCP_OUTPUT_BYTE_LIMIT + 1000) });
    const result = toToolResult(oversized);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
    expect(text).not.toContain("x".repeat(100));
    expect(() => JSON.parse(text)).toThrow();
  });

  it("[oversized error message] an error whose own message is oversized also falls back to the same fixed error", () => {
    const oversized: ServiceResult<never> = validationError(
      "y".repeat(MCP_OUTPUT_BYTE_LIMIT + 1000),
    );
    const result = toToolResult(oversized);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
    expect(text).not.toContain("y".repeat(100));
  });

  it("[expected NOT_FOUND] a normal not-found error stays comfortably under the byte ceiling", () => {
    const result = toToolResult(notFound("PROGRAM", "PROGRAM-DOES-NOT-EXIST"));
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
    expect(text).toContain("PROGRAM-DOES-NOT-EXIST");
  });

  it("[unexpected thrown error] runTool() converts any thrown exception into one fixed safe message under the byte ceiling", async () => {
    const result = await runTool(async () => {
      throw new Error(
        "PrismaClientKnownRequestError: connection to server at host.internal failed with credentials user=admin",
      );
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
    expect(text).not.toMatch(/prisma/i);
    expect(text).not.toContain("host.internal");
    expect(text).not.toContain("admin");
    expect(text).not.toContain("credentials");
  });

  it("[overlong entityId] an error's entityId is only echoed when it independently passes the MCP ID bound — an overlong one is silently omitted, never truncated into a misleading value", () => {
    const overlongId = "Z".repeat(1_000_000);
    const result = toToolResult(notFound("REQUIREMENT", overlongId));
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).not.toContain(overlongId);
    expect(text).not.toContain("Z".repeat(200));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
  });

  it("[well-formed entityId] a normal, in-bounds entityId is still echoed", () => {
    const result = toToolResult(notFound("MILESTONE", "MS-999"));
    expect(textOf(result)).toContain("MS-999");
  });

  it("[real UTF-8 byte measurement, not string.length] a multi-byte payload just under the JS string-length ceiling but over the real UTF-8 byte ceiling is still caught", () => {
    // Each "😀" is 2 UTF-16 code units (counted by .length) but 4 UTF-8
    // bytes. 8001 copies: .length = 16002 (nowhere near 32000), but the
    // true UTF-8 byte length is 32004 — over the ceiling. A naive
    // string-length-based guard would let this through; a correct
    // Buffer.byteLength-based guard must not.
    const emojiBlob = "😀".repeat(8001);
    expect(emojiBlob.length).toBeLessThan(MCP_OUTPUT_BYTE_LIMIT);
    const oversized = ok({ blob: emojiBlob });
    const result = toToolResult(oversized);
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("😀");
  });

  it("[quotes, backslashes, newlines] a payload that looks small in raw string length but expands under JSON.stringify escaping is measured by the serialized bytes", () => {
    // Every character here expands to 2 bytes once JSON-escaped
    // (\" or \\ or \n) — a guard that measured the raw object's field
    // lengths before stringifying would undercount this.
    const escapeHeavy = '"\\\n'.repeat(Math.ceil((MCP_OUTPUT_BYTE_LIMIT + 500) / 3));
    const oversized = ok({ blob: escapeHeavy });
    const result = toToolResult(oversized);
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
  });

  it("[normal-sized results are unaffected] a small, well-formed success result passes through unchanged", () => {
    const result = toToolResult(
      ok({ programId: "PROGRAM-EDGELINK-X", counts: { requirements: 8 } }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      programId: "PROGRAM-EDGELINK-X",
      counts: { requirements: 8 },
    });
  });
});
