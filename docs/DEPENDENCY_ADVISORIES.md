# Dependency advisory baseline

Human-readable rendering of `scripts/dependency-advisory-baseline.json`,
the machine-readable source of truth `npm run check:audit`
(`scripts/check-audit.mjs`) actually checks against. **Passing
`check:audit` means "no new, unreviewed high or critical advisory" — never
"zero vulnerabilities."** Every row below is a deliberate, reviewed,
currently-accepted deferral, not an oversight; `check:audit` fails CI the
moment a **new** high/critical advisory appears that isn't already listed
here.

Last full review: **2026-08-01** (Phase 8), against a fresh `npm audit
--json` run — not against any earlier phase's historical finding count.
`npm audit fix` (never `--force`) was applied first, resolving 5 of the 8
findings present at the start of that review (`@prisma/dev`,
`brace-expansion`, `find-my-way`, `prisma`, `valibot` — all compatible,
non-breaking version bumps within already-declared semver ranges). The 4
advisories below (affecting 2 packages) are everything that remained.

| Advisory                                                                 | Package   | Installed | Path                                                                                 | Reachability                                                                                                                                                               | Compatible fix?                                   |
| ------------------------------------------------------------------------ | --------- | --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | `postcss` | 8.4.31    | `next` → `node_modules/next/node_modules/postcss` (bundled inside `next`'s own tree) | Production dependency chain (`next`), but the vulnerable path (attacker-controlled `sourceMappingURL` parsing) is never exercised — this app never processes untrusted CSS | No — only `next@9.3.3` (breaking major downgrade) |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | `postcss` | 8.4.31    | same as above                                                                        | Same as above (path traversal via `sourceMappingURL` auto-loading)                                                                                                         | No — only `next@9.3.3` (breaking major downgrade) |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | `postcss` | 8.4.31    | same as above                                                                        | Same as above (XSS via unescaped `</style>`); individually "moderate," included for completeness — `check:audit` only gates high/critical                                  | No — only `next@9.3.3` (breaking major downgrade) |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | `sharp`   | 0.34.5    | `next` → `sharp` (an optional dependency of `next`, used only by `next/image`)       | Never invoked: `apps/web/src` never imports `next/image` anywhere (verified by direct source search)                                                                       | No — only `next@9.3.3` (breaking major downgrade) |

**Why not force-fix:** every remaining advisory's only available fix is
`next@9.3.3`, a breaking major-version downgrade three-plus major versions
behind the `next@16.x` this project is built on
(`fixAvailable.isSemVerMajor: true` in `npm audit`'s own output) — not a
patch release. Downgrading the entire web framework to resolve advisories
in code paths this application doesn't reachably exercise would be a
materially worse trade than the advisories themselves. `npm audit fix
--force` is never run in this repository.

## How this baseline is enforced

- `npm run check:audit` runs `npm audit --json`, extracts every
  individually-high-or-critical advisory (an object entry in a package's
  `via` array — not a bare string, which just names another affected
  package rather than being an advisory itself), and compares each by its
  exact `(advisoryId, package)` identity against
  `scripts/dependency-advisory-baseline.json`.
- Any advisory **not** already in the baseline fails the check (and CI).
- Every advisory already in the baseline is printed but does not fail the
  check — visibility without blocking a merge on an already-triaged
  finding.
- CI (`.github/workflows/ci.yml`, "Dependency vulnerability scan" step)
  runs this same command as a real gate — no `continue-on-error`.

## Updating this baseline

When `npm audit` reports a genuinely new advisory:

1. Run `npm audit fix` (never `--force`) first — most new advisories in
   actively-maintained dependency chains resolve this way.
2. If a compatible fix isn't available, decide whether the advisory is
   actually reachable by this application's own code paths.
3. Add a reviewed entry to `scripts/dependency-advisory-baseline.json`
   with the advisory ID, package, installed version, dependency path,
   reachability assessment, fix status, and today's date — and a matching
   row here, and a dated entry in `docs/DECISIONS.md`.
4. Never add an entry just to make CI pass without doing the reachability
   assessment — that defeats the entire point of this gate.
