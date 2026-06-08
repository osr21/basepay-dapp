---
name: Aerodrome Swap Architecture
description: Gasless USDC↔EURC swap via Aerodrome Router on Base — race condition root cause, atomic fix, and Expired() clock-drift bug
---

## Aerodrome Finance contracts on Base (confirmed live)

- PoolFactory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` (40 hex chars — note trailing 'a')
- Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- USDC/EURC volatile pool: `0xFDF5139b38525627B47538536042A7c8d2686BD9`
- Uniswap V3 has zero USDC/EURC liquidity on Base — Aerodrome only
- Volatile pool often gives better rate than stable — always try both and pick best

## Current swap flow (router-based, atomic — implemented)

1. Quote endpoint (`GET /api/swap/quote`) returns `relayerAddress` (relay wallet's public address)
2. User signs EIP-3009: `transferWithAuthorization(from=user, to=relay, amount)` — relay wallet is the `to`
3. TX1: relay submits `transferWithAuthorization` → USDC/EURC moves user → relay wallet
4. Relay checks allowance for Aerodrome Router; approves max uint256 once if insufficient
5. TX2: relay calls `router.swapExactTokensForTokens(amountIn, amountOutMin, routes, user, deadline)`
   → Router atomically deposits tokenIn from relay into pool, then calls `pool.swap`, output goes directly to user

SwapInput sends `stable: boolean` (NOT `poolAddress`) — server constructs route from it.

## Aerodrome Router `Expired()` custom error — clock drift

**Custom error selector:** `0x203d82d8` = `Expired()` from the `ensure(deadline)` modifier:
```solidity
modifier ensure(uint256 deadline) {
    if (block.timestamp > deadline) revert Expired();
    _;
}
```

**Root cause:** The Replit/production server's `Date.now()` can run significantly BEHIND Base mainnet's `block.timestamp` (drift > 300s observed in production). The server calculates `deadline = Math.floor(Date.now()/1000) + N`, but if the server clock lags, `block.timestamp > deadline` at TX execution time.

**Fix:** Set deadline to `+7200s` (2 hours) instead of `+300s` (5 minutes). This is safe because the user's EIP-3009 `validBefore` is the actual security expiry; the router deadline is just a stale-swap guard.

**Why only one direction failed:** The USDC→EURC swap happened to execute within the clock-drift window; the EURC→USDC attempt hit a moment where server clock lag exceeded the 300s buffer.

**Recovery if TX2 reverts:** Relay holds tokenIn directly → `ERC20.transfer(user, amount)`. The refund uses `writeWithRetry` but may also fail if relay is still in-flight from TX1. Stuck tokens at relay must be manually recovered with the `scripts/src/refund-stuck.ts` pattern (iterate tokens, retry with 2s × (attempt+1) backoff for in-flight errors).

## Root cause of original race condition (pool.swap directly)

- Old TX1: `transferWithAuthorization(user → pool)` — token deposited into pool as excess balance
- Old TX2: `pool.swap(amount0Out, 0, user, 0x)` — FAILED with `InsufficientInputAmount()` (`0x098fb561`)
- **Why:** Any tx between TX1 and TX2 that syncs pool reserves makes `balance == reserve` → pool sees zero input → reverts

## EIP-7702 relayer "in-flight transaction limit" retry

The RELAYER wallet (`0xdb5019b8...`) is an EIP-7702 delegated account. Base RPC enforces a limit of 1 pending tx at a time for delegated accounts. Even after `waitForTransactionReceipt({ confirmations: 1 })` returns, there is a brief window where the sequencer still considers the previous tx in-flight.

**Fix:** `writeWithRetry(fn, label, maxAttempts=6)` — catches the in-flight error, waits 1.5s × (attempt+1), retries up to 6 times. Wrap ALL `relayer.client.writeContract` calls in this helper.

## Smart wallet / EIP-7702 incompatibility with EIP-3009

EIP-3009 uses `ecrecover`-based signature verification. Passkey-based smart wallets produce WebAuthn signatures incompatible with `ecrecover`. Always check `eth_getCode` on the user's address; if bytecode exists, disable the gasless swap and show a warning.

## Token address comparison gotcha

Always define lowercase constants for comparison:
```typescript
const USDC_LC = USDC.toLowerCase();
if (input.toLowerCase() === USDC_LC) { ... }
```
Never compare `input.toLowerCase() === USDC` when USDC is a checksummed address — will always fail.
