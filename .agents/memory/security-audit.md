---
name: Security Audit Results
description: Findings and fixes from the BasePay opsec scan — what was real vs false positive
---

## Dependency Vulnerabilities Fixed
Both are transitive-only; pinned via `overrides:` in `pnpm-workspace.yaml`:
- `qs: 6.15.2` — fixes CVE-2026-8723 (DoS in qs.stringify with comma+null); pulled in by express/body-parser
- `tmp: 0.2.6` — fixes CVE-2025-54798 + CVE-2026-44705 (path traversal via symlink); pulled in by solc in scripts package only (not server code)

## Code Fixes Applied

### JWT Secret Derivation (developer.ts)
**Bug:** `s.padEnd(32,"0").slice(0,64)` — pads short secrets with zeros (false entropy), truncates long ones.
**Fix:** `new TextEncoder().encode(s)` — use the raw secret bytes; add minimum-32-char check.
**Why:** Padding with zeros makes a 4-char secret effectively "abc\0\0\0..." which is far weaker than it appears.

### JWT Algorithm Enforcement (developer.ts)
**Bug:** `jwtVerify(token, key)` — no `algorithms` option, vulnerable to alg-confusion (alg:none or RS256 attack).
**Fix:** `jwtVerify(token, key, { algorithms: ["HS256"] })` — explicitly restrict accepted algorithms.

### Auth Rate Limiting (developer.ts)
**Bug:** `POST /api/developer/auth` calls `viem.verifyMessage` (expensive ECDSA verification) with no rate limit.
**Fix:** In-memory Map rate limiter — 20 attempts per IP per hour, with hourly pruning via `setInterval(...).unref()`.

## False Positives (no action needed)

### HoundDog CRITICAL × 9 — "Encryption Key sent to Standard Output"
All in `scripts/src/` deploy scripts. These scripts read `DEPLOYER_PRIVATE_KEY` and derive the account via `privateKeyToAccount()`, but only print `account.address` (the public address) — never the raw private key. Scanner flags the data flow from env → privateKeyToAccount as "key to stdout" incorrectly.

### SAST Medium — Path traversal in verify-contracts.ts
`readFileSync(resolve(root, entry.file))` — `entry.file` comes from a hardcoded CONTRACTS array constant, not user input. Scanner doesn't trace the constant origin.

### SAST Medium — Dynamic method in mockup-sandbox/App.tsx
Intentional pattern for dynamic component rendering in a dev-only preview tool.

## Existing Protections (confirmed good)
- EIP-3009 nonce: checked in-memory (`pendingNonces` Set) + DB (`gasless_nonces`) + on-chain (`authorizationState`)
- CCTP messageHash: validated with `/^0x[0-9a-fA-F]{64}$/` regex before proxying to Circle API
- Token whitelist: gasless/relay only accepts USDC and EURC (hardcoded Map)
- Max amounts: relay capped at 1M USDC; swap capped at 10K
- All inputs: Zod schemas with address validation via `viem.isAddress`
- SQL: Drizzle ORM with parameterized queries throughout
