import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// OWASP-recommended minimum scrypt parameters for interactive login
// (N=2^14, r=8, p=1), matching Node's documented crypto.scrypt defaults.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Bounds enforced when *verifying* a stored hash's embedded cost
// parameters — never when hashing, which always uses the fixed constants
// above. A row could contain a corrupted or tampered value (bad migration,
// manual edit, future bug); these bounds keep such a value from either
// (a) making verification trivially weak — a tiny N defeats the whole
// point of a memory-hard KDF — or (b) making a single login attempt
// expensive enough to be a denial-of-service vector. 128*N*r is scrypt's
// approximate memory footprint in bytes; capping it keeps every verify
// call comfortably under Node's default 32 MiB scrypt memory limit
// without needing to override `maxmem`.
const MIN_N = 2 ** 10;
const MAX_N = 2 ** 17;
const MIN_R = 1;
const MAX_R = 16;
const MIN_P = 1;
const MAX_P = 8;
const MAX_SCRYPT_MEMORY_BYTES = 24 * 1024 * 1024;

// Salt/key lengths are validated against a range, not pinned to the current
// SALT_LENGTH/KEY_LENGTH constants, so those constants can change later
// without invalidating hashes already stored under the old lengths.
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 128;

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Produces a self-describing hash string: scrypt:N:r:p:saltHex:hashHex.
 * Embedding the parameters lets future code change the cost factor without
 * breaking verification of hashes created under the old parameters.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Fully validates a stored hash string before any bytes are derived from
 * it, returning null on the first violation instead of coercing bad input
 * forward. This closes a real bypass: `Buffer.from(str, "hex")` silently
 * stops at the first invalid character rather than throwing, so a
 * corrupted stored hash with non-hex salt/hash fields could previously
 * decode to two empty buffers — scrypt happily derives a 0-byte key from a
 * 0-byte salt, and `timingSafeEqual` on two empty buffers returns true,
 * authenticating as any password. Every field is checked for exact shape
 * (marker, field count, integer-only cost params, in-range and power-of-two
 * N, even-length hex of a plausible byte length) before scrypt ever runs.
 */
function parseStoredHash(storedHash: string): ParsedHash | null {
  const parts = storedHash.split(":");
  if (parts.length !== 6) {
    return null;
  }

  const [marker, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (marker !== "scrypt") {
    return null;
  }
  if (!nStr || !rStr || !pStr || !saltHex || !hashHex) {
    return null;
  }
  if (
    !UNSIGNED_INTEGER_PATTERN.test(nStr) ||
    !UNSIGNED_INTEGER_PATTERN.test(rStr) ||
    !UNSIGNED_INTEGER_PATTERN.test(pStr)
  ) {
    return null;
  }

  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);

  // N must be a power of two — the same requirement Node's own scrypt
  // enforces — checked here so a non-power-of-two value is rejected
  // cleanly instead of throwing out of the scrypt call below.
  const isPowerOfTwo = n > 0 && (n & (n - 1)) === 0;
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N || !isPowerOfTwo) {
    return null;
  }
  if (!Number.isInteger(r) || r < MIN_R || r > MAX_R) {
    return null;
  }
  if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
    return null;
  }
  if (128 * n * r > MAX_SCRYPT_MEMORY_BYTES) {
    return null;
  }

  if (
    saltHex.length % 2 !== 0 ||
    saltHex.length < MIN_SALT_BYTES * 2 ||
    saltHex.length > MAX_SALT_BYTES * 2 ||
    !HEX_PATTERN.test(saltHex)
  ) {
    return null;
  }
  if (
    hashHex.length % 2 !== 0 ||
    hashHex.length < MIN_KEY_BYTES * 2 ||
    hashHex.length > MAX_KEY_BYTES * 2 ||
    !HEX_PATTERN.test(hashHex)
  ) {
    return null;
  }

  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");
  // Belt-and-suspenders: the checks above already guarantee this, but a
  // decoded buffer is never trusted for key derivation without confirming
  // its length actually matches what its own hex string implied.
  if (salt.length !== saltHex.length / 2 || hash.length !== hashHex.length / 2) {
    return null;
  }

  return { n, r, p, salt, hash };
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) {
    return false;
  }

  try {
    const actual = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
    // Lengths are already guaranteed equal by parseStoredHash, but
    // timingSafeEqual throws on mismatched lengths, so keep the guard.
    if (actual.length !== parsed.hash.length) {
      return false;
    }
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    // Fail closed: any unexpected scrypt error (e.g. an edge case in Node's
    // own parameter validation this function didn't anticipate) must never
    // propagate out of an auth check as an unhandled exception.
    return false;
  }
}
