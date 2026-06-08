---
name: Aerodrome Swap Architecture
description: Gasless USDC↔EURC swap via Aerodrome Router on Base — race conditions, root causes, and all fixes applied
---

## Aerodrome Finance contracts on Base (confirmed live)

- PoolFactory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`
- Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- USDC/EURC volatile pool: `0xFDF5139b38525627B47538536042A7c8d2686BD9`
- Uniswap V3 has zero USDC/EURC liquidity on Base — Aerodrome only
- Volatile pool often gives better rate than stable — always try both and pick best

## Current swap flow (router-based, atomic — implemented)

1. Quote endpoint (`GET /api/swap/quote`) returns `relayerAddress` (relay wallet's public address)
2. User signs EIP-3009: `transferWithAuthorization(from=user, to=relay, amount)` — relay wallet is the `to`
3. TX1: relay submits `transferWithAuthorization` → token moves user → relay wallet (waits 1 confirm)
4. Relay waits 1.5s for RPC state to propagate
5. Relay checks allowance for Aerodrome Router; approves max uint256 once if insufficient
6. TX2: relay calls `router.swapExactTokensForTokens(amountIn, amountOutMin, routes, user, deadline)`
   with `gas: 350_000n` to skip eth_estimateGas
   → Router atomically deposits tokenIn from relay into pool, delivers output to user
7. Return txHash immediately (do NOT wait for TX2 receipt — avoids proxy timeout)

## Bug 1: Aerodrome Router `Expired()` — server clock drift

**Custom error selector:** `0x203d82d8`

**Root cause:** Replit/production server `Date.now()` runs significantly BEHIND Base mainnet's
`block.timestamp`. Old deadline was `now + 300s`; when drift > 300s, `block.timestamp > deadline`
and `Expired()` fires during `eth_estimateGas`.

**Fix:** Deadline set to `now + 7200s` (2 hours). Safe because EIP-3009 `validBefore` is the
real security expiry; the router deadline is only a stale-swap guard.

## Bug 2: TX2 `eth_estimateGas` false-revert — RPC state lag

**Error:** `"execution reverted for an unknown reason"` — viem's `ContractFunctionExecutionError`
with no decoded custom error.

**Root cause:** viem simulates `eth_estimateGas` against the *pending/current* block state before
it includes TX1's confirmed state. The router's `transferFrom(relay, pool, amount)` sees zero
tokenIn balance at the relay (TX1 just confirmed but the RPC node hasn't indexed it yet) and
reverts. The error is a custom error (`InsufficientInputAmount` or similar) whose selector is NOT
in our router ABI, so it decodes as "unknown reason."

**Fix 1:** Set `gas: 350_000n` explicitly on the TX2 `writeContract` call. This bypasses
`eth_estimateGas` entirely; viem sends the transaction directly. On-chain execution uses the
canonical confirmed state (TX1 IS already in a block), so TX2 succeeds.

**Fix 2:** Add `await new Promise(r => setTimeout(r, 1_500))` between TX1 receipt and TX2
submission to let the RPC's state index catch up.

**Why 350k gas:** Typical gas for a single-hop Aerodrome volatile swap is 150k–250k. 350k
gives comfortable headroom without being wasteful.

## Bug 3: Production proxy timeout — HTTP 500 "Internal Server Error"

**Root cause:** Old code waited for TX2 receipt inside the HTTP handler. Combined TX1 + TX2
confirmation (~10-20s) + in-flight retries exceeded Replit production proxy timeout. Proxy killed
the request and returned a generic 500 with empty `statusText` (HTTP/2) and body
`{"error": "Internal Server Error"}` — which `buildErrorMessage` formats as
`"HTTP 500 : Internal Server Error"`.

**Fix:** Return txHash immediately after TX2 submission without waiting for the receipt.
Base confirms in ~2s. If TX2 reverts on-chain (rare — slippage guard is server-side), tokens
remain at the relay and must be recovered via the refund pattern below.

## EIP-7702 relayer "in-flight transaction limit" retry

The relay wallet is EIP-7702 delegated. Base RPC enforces max 1 pending tx at a time. Even after
`waitForTransactionReceipt({ confirmations: 1 })` returns, the sequencer briefly considers the
tx in-flight. Fix: `writeWithRetry(fn, label, maxAttempts=6)` — catches the in-flight error,
waits 1.5s × (attempt+1), retries up to 6 times.

## Original race condition (pool.swap directly — old broken approach)

- Old TX1: `transferWithAuthorization(user → pool)` — excess balance in pool
- Old TX2: `pool.swap(...)` — FAILED with `InsufficientInputAmount()` (`0x098fb561`) if any
  tx synced the pool's reserves between TX1 and TX2.
- **Router approach is the fix** — atomic deposit+swap in one TX.

## Refund pattern for stuck tokens at relay

When TX2 fails after TX1 (tokens at relay), write a one-off script:

```typescript
// scripts/src/refund-stuck.ts
for (const token of [EURC, USDC]) {
  const bal = await pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [relayAddress] });
  if (bal < 1_000n) continue;
  for (let i = 0; i < 6; i++) {
    try {
      const hash = await wal.writeContract({ ..., functionName: "transfer", args: [USER, bal] });
      await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
      break;
    } catch(e) {
      if (e.message?.includes("in-flight") && i < 5) { await sleep(2000*(i+1)); }
      else throw e;
    }
  }
}
```

Add to `scripts/package.json` as `"refund-stuck": "tsx ./src/refund-stuck.ts"`, run, then remove.

## Smart wallet incompatibility with EIP-3009

EIP-3009 uses `ecrecover`. Passkey-based smart wallets produce WebAuthn signatures incompatible
with `ecrecover`. Check `eth_getCode` on user address; if bytecode exists, disable gasless swap.

## Token address comparison gotcha

Always lowercase both sides: `input.toLowerCase() === USDC.toLowerCase()`. Never compare
`input.toLowerCase() === USDC` when USDC is checksummed — always fails.
