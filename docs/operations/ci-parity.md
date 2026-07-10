# CI Parity

AP-103 tracks whether the gates humans rely on locally are represented by
GitHub Actions or explicitly classified as release/manual checks.

## Required CI Gates

| Gate | Local command | GitHub Actions coverage | Status |
| --- | --- | --- | --- |
| Install reproducibility | `npm ci` | `.github/workflows/ci.yml` check job | CI required |
| Static lint | `npm run lint` | explicit check job step and included in `npm run check:all` | CI required |
| TypeScript type safety | `npm run typecheck` | explicit check job step and included in `npm run check:all` | CI required |
| Deterministic project checks | `npm run check:all` | `.github/workflows/ci.yml` check job | CI required |
| Behavioral end-to-end checks | `npm run check:e2e` | `.github/workflows/ci.yml` check job | CI required |
| DocStore PR hygiene | `npm run doc-store:doctor`; `npm run doc-store:enforce-staged -- --base main` | `.github/workflows/ci.yml` `doc-store` PR job | PR CI required |
| Public narrative scan | `npm run check:public-narrative` | included in `npm run check:all` | CI required |
| Runtime proof for current repo resources and smoke/gateTrust paths | `npm run check:runtime-proof` | included in `npm run check:all` | CI required |
| CLI critical-path smoke (trusted proof) | `npm run check:smoke` | included in `npm run check:all` | CI required |
| Distribution manifest/package validation | `npm run validate:distribution` | included in `npm run check:all` | CI required |

## Release/Manual Gates

| Gate | Command | Why not normal CI |
| --- | --- | --- |
| LLM quality observation | `npm run check:quality`; `node e2e/quality/run-quality.mjs --all --no-judge`; `node e2e/quality/run-quality.mjs --trend` | Full judged runs require model credentials and produce trend evidence rather than a deterministic per-PR pass/fail signal. AP-106 owns eval/quality history hardening. |
| Clean install smoke | `npm pack --dry-run --json`; clean temp install from `docs/operations/open-source-readiness-checklist.md` | It is release-context evidence tied to the package artifact/adopter install path. `npm run validate:distribution` remains the deterministic CI proxy. |
| Website preview | Deploy workflow or local static preview screenshot | Requires Pages/deployment context and is release evidence, not a core code gate. |

## Current Verification

Run before marking CI parity current:

```bash
npm run typecheck
npm run check:public-narrative
npm run check:all
npm run check:e2e
```

The CI workflow must keep `npm ci`, `npm run typecheck`, `npm run check:all`,
`npm run lint`, `npm run check:e2e`, and the PR-only DocStore job visible as separate workflow
evidence, even when some commands are also nested inside `check:all`.
