---
name: Developer API Key Auth
description: Wallet-auth JWT session + bpk_ prefixed x402 bypass keys for the developer portal
---

## Auth Flow
1. Frontend constructs message: `"BasePay Developer Portal\nAddress: {addr}\nTimestamp: {unix}"`
2. User signs with `signMessageAsync` (wagmi)
3. POST `/api/developer/auth` → server verifies via viem `verifyMessage`, issues HS256 JWT (24h, signed with SESSION_SECRET)
4. JWT stored in localStorage as `{ token, address, expiresAt }` under key `basepay_dev_auth`
5. Timestamp window: must be within 600 seconds of server time (replay protection)

## API Key Format
- Raw key: `bpk_` + 64 hex chars (32 random bytes) = 68 chars total
- Stored: SHA-256 hash of raw key (`keyHash`) + first 12 chars for display (`keyPrefix`)
- The raw key is returned ONCE at creation time and never stored

## x402 Bypass
`checkApiKey` middleware in `x402relay.ts` runs before the x402Gate. If `X-API-Key` header starts with `bpk_`, it hashes it and checks against `developer_keys` table. On match, sets `req.__apiKeyAuth = true` which skips x402Gate and increments `requestCount` asynchronously.

## Express 5 / TypeScript Quirks
- `requireAuth` middleware MUST use `return next()` (not just `next()`) to satisfy `noImplicitReturns` — TypeScript sees mixed return paths
- `req.params.id` in chained middleware routes may be inferred as `string | string[]` — cast with `req.params.id as string`

**Why:** Express 5's type inference for route handler chains with preceding middlewares can lose the ParamsDictionary narrowing.

## DB Schema
Table: `developer_keys` — id, walletAddress, name, keyPrefix, keyHash, createdAt, revokedAt, lastUsedAt, requestCount
Max 10 active keys per wallet address.
