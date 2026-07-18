import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password against its hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash and salt each time", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
  });

  it("embeds the scrypt cost parameters in the stored hash", async () => {
    const hash = await hashPassword("password");
    expect(hash.split(":")).toEqual([
      "scrypt",
      "16384",
      "8",
      "1",
      expect.any(String),
      expect.any(String),
    ]);
  });
});

describe("verifyPassword — malformed stored hashes never authenticate", () => {
  // Regression coverage for the empty-buffer bypass: Buffer.from(str, "hex")
  // silently truncates at the first invalid character instead of throwing,
  // so garbage hex previously decoded to two zero-length buffers, and
  // timingSafeEqual(emptyBuffer, emptyBuffer) is true — authenticating any
  // password against a corrupted row. Every case below must return false
  // for every password tried against it.
  const anyPasswords = ["", "a", "correct horse battery staple", "🔥 unicode 密码"];

  const malformedHashes: Record<string, string> = {
    "invalid hex in both fields (the original bypass)": "scrypt:16384:8:1:zz:zz",
    "invalid hex in salt only":
      "scrypt:16384:8:1:zznothex:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "invalid hex in hash only": "scrypt:16384:8:1:aabbccddeeff00112233445566778899:zznothex",
    "empty salt field":
      "scrypt:16384:8:1::aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "empty hash field": "scrypt:16384:8:1:aabbccddeeff00112233445566778899:",
    "odd-length salt hex":
      "scrypt:16384:8:1:abc:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "odd-length hash hex": "scrypt:16384:8:1:aabbccddeeff00112233445566778899:abc",
    "truncated salt (below minimum length)":
      "scrypt:16384:8:1:aa:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "truncated derived key (below minimum length)":
      "scrypt:16384:8:1:aabbccddeeff00112233445566778899:aabb",
    "unsupported algorithm marker":
      "bcrypt:16384:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "missing algorithm marker (extra colon shifts fields)":
      ":16384:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "non-integer N":
      "scrypt:16384.5:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "negative N":
      "scrypt:-16384:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "zero N":
      "scrypt:0:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "N not a power of two":
      "scrypt:16000:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "excessive N (memory-exhaustion attempt)":
      "scrypt:1048576:8:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "excessive combined N*r memory footprint":
      "scrypt:131072:16:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "zero r":
      "scrypt:16384:0:1:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "zero p":
      "scrypt:16384:8:0:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "extra field":
      "scrypt:16384:8:1:extra:aabbccddeeff00112233445566778899:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900",
    "missing field": "scrypt:16384:8:1:aabbccddeeff00112233445566778899",
    "completely unstructured garbage": "not-a-hash-at-all",
    "empty string": "",
  };

  for (const [description, malformed] of Object.entries(malformedHashes)) {
    it(`rejects: ${description}`, async () => {
      for (const password of anyPasswords) {
        expect(await verifyPassword(password, malformed)).toBe(false);
      }
    });
  }
});
