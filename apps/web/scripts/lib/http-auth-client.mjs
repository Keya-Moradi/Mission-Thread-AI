// Shared, plain-fetch (no browser, no Prisma) helpers for driving the real
// Auth.js Credentials flow over HTTP against an already-running server —
// used by apps/web/scripts/smoke-test.mjs (which spawns `next start` itself)
// and apps/web/scripts/docker-runtime-check.mjs (which points at an
// already-running Docker container instead). Extracted rather than
// duplicated: the CSRF-token/cookie-jar dance is subtle enough that two
// independently-maintained copies would be a real place for them to
// silently drift apart.
import { setTimeout as sleep } from "node:timers/promises";

/** Minimal cookie jar: tracks the latest value for each cookie name across
 * requests, the same way a browser (or curl -b/-c) would, since Auth.js's
 * credentials flow spans a CSRF-token request, a sign-in POST, and then
 * authenticated requests that must all share accumulated cookies. */
export class CookieJar {
  #cookies = new Map();

  absorb(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex === -1) continue;
      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);
      if (value === "" || setCookie.toLowerCase().includes("max-age=0")) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSessionCookie() {
    return [...this.#cookies.keys()].some((name) => name.includes("session-token"));
  }
}

/** Polls `${baseUrl}/login` until it returns 200 or `timeoutMs` elapses. */
export async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/login`);
      if (res.status === 200) return;
    } catch {
      // Server not accepting connections yet — keep polling.
    }
    await sleep(300);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

/** Drives the real Auth.js Credentials callback (CSRF token, then sign-in
 * POST) against `baseUrl`, absorbing cookies into `jar` as a browser would. */
export async function signIn(baseUrl, jar, email, password) {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  jar.absorb(csrfRes);
  const { csrfToken } = await csrfRes.json();

  const body = new URLSearchParams({
    email,
    password,
    csrfToken,
    redirectTo: "/",
    json: "true",
  });

  const signInRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    body: body.toString(),
    redirect: "manual",
  });
  jar.absorb(signInRes);
  return signInRes;
}

/**
 * Reads the text content of the first element carrying the given
 * data-testid attribute. Used instead of searching the whole page for a
 * bare value (e.g. `includes(">8<")`), which could pass because the number
 * happens to appear somewhere unrelated, such as a count that isn't the
 * one actually being checked.
 */
export function getTestIdText(html, testId) {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  return match ? match[1].trim() : null;
}

/**
 * Counts elements carrying a given data-testid attribute. Deliberately not
 * a plain text-occurrence count: Next.js's App Router streams a serialized
 * RSC "flight" payload alongside the rendered HTML for hydration, which
 * re-embeds every rendered string a second time inside a <script> tag as
 * escaped JSON (`\"like this\"`) — a bare `html.match(/some text/g)` count
 * would therefore double-count everything. An exact, unescaped
 * `data-testid="..."` attribute match only appears in the actual rendered
 * markup, never inside that escaped payload, so this stays an accurate
 * count of real DOM elements.
 */
export function countTestId(html, testId) {
  return (html.match(new RegExp(`data-testid="${testId}"`, "g")) ?? []).length;
}
