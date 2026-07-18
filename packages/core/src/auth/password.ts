import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// OWASP-recommended minimum scrypt parameters for interactive login
// (N=2^14, r=8, p=1), matching Node's documented crypto.scrypt defaults.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Produces a self-describing hash string: scrypt:N:r:p:saltHex:hashHex.
 * Embedding the parameters lets future code change the cost factor without
 * breaking verification of hashes created under the old parameters.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (!nStr || !rStr || !pStr || !saltHex || !hashHex) {
    return false;
  }
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });

  // Buffers must be equal length before timingSafeEqual, or it throws.
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
