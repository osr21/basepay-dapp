# Gasless USDC ↔ EURC Swap

  BasePay supports **zero-gas, one-signature token swaps** between USDC and EURC on Base Mainnet, routed through [Aerodrome Finance](https://aerodrome.finance) — the dominant AMM on Base.

  **Live:** [basepay.replit.app/swap](https://basepay.replit.app/swap)

  ---

  ## Overview

  | Parameter | Value |
  |---|---|
  | Token pair | USDC ↔ EURC |
  | Pool | Aerodrome Finance volatile pool |
  | Pool address | `0xFDF5139b38525627B47538536042A7c8d2686BD9` |
  | Pool fee | 0.3% of input (volatile AMM) |
  | Protocol fee | 0% (BasePay charges nothing) |
  | ETH cost to user | **$0.00** |
  | Signatures required | **1** (EIP-3009 off-chain) |
  | Max swap amount | 10,000 tokens |
  | Slippage tolerance | 0.5% default (1–100 bps configurable) |

  ---

  ## How It Works

  The swap uses **two relayer transactions** submitted on the user's behalf — the user only signs one off-chain message:

  ```
  User                     BasePay API                    Base Mainnet
   │                            │                               │
   │─ GET /api/swap/quote ─────▶│── getAmountsOut (stable) ───▶│ Aerodrome
   │                            │── getAmountsOut (volatile) ──▶│ Router
   │◀─ { amountOut, relayer } ──│◀─ best quote ─────────────────│
   │                            │                               │
   │─ sign EIP-3009 ────────────│ (off-chain, no gas)           │
   │  (from=user, to=relay,     │                               │
   │   value=amountIn)          │                               │
   │                            │                               │
   │─ POST /api/swap/execute ──▶│                               │
   │                            │── TX1: transferWithAuthorization ▶│ USDC/EURC
   │                            │   (user → relay, confirmations=1) │ contract
   │                            │                               │
   │                            │── wait 1.5s for RPC state ────│
   │                            │                               │
   │                            │── TX2: router.swapExactTokensForTokens ▶│ Aerodrome
   │                            │   (relay → pool → user, gas=350_000)    │ Router
   │                            │                               │
   │◀─ { txHash } ──────────────│ (returns immediately)         │
   │                            │                               │
   │                  ≈2s later: EURC/USDC arrives in user wallet
  ```

  ### Step-by-step

  1. **Quote** — client calls `GET /api/swap/quote`. The server queries both the stable and volatile Aerodrome pools and returns the best rate, along with the relay wallet address.

  2. **Sign** — user signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` message authorising the relay wallet to receive their tokens. Off-chain — no gas, no on-chain transaction.

  3. **TX1** — relay submits `token.transferWithAuthorization(from=user, to=relay, value, ...)`. Tokens move from the user's wallet to the relay wallet. The relay confirms 1 block before proceeding.

  4. **TX2** — relay submits `router.swapExactTokensForTokens(amountIn, amountOutMin, routes, user, deadline)`. The Aerodrome Router atomically:
     - Pulls `tokenIn` from the relay via `transferFrom`
     - Deposits into the pool
     - Executes the swap
     - Delivers `tokenOut` directly to the user's wallet

  5. **Done** — the swap transaction hash is returned immediately. Base confirms in ~2 seconds.

  ---

  ## Why Two Transactions?

  EIP-3009 `transferWithAuthorization` can only move tokens to a **specific `to` address** embedded in the signature. The Aerodrome Router pulls tokens from its caller via `transferFrom`, not via an authorization — so we cannot sign a single EIP-3009 message that points directly at the pool.

  The two-TX design is necessary: TX1 moves tokens to the relay (which the user authorized), and TX2 uses the relay as the swap initiator so the router can `transferFrom` the relay into the pool.

  An earlier single-TX design (direct `transferWithAuthorization(user → pool)` + `pool.swap()`) was abandoned because any pool state change between the two calls (another swap, a sync) would cause `pool.swap()` to revert with `InsufficientInputAmount()`. The Aerodrome Router solves this by atomically depositing and swapping in a single call.

  ---

  ## API Reference

  ### GET /api/swap/quote

  Returns the best Aerodrome pool quote for a given pair and amount.

  **Query parameters**

  | Field | Type | Description |
  |---|---|---|
  | `tokenIn` | address | Input token (`0x833589f...` USDC or `0x60a3E35...` EURC) |
  | `tokenOut` | address | Output token |
  | `amountIn` | string | Integer atomic units (6 decimals), e.g. `"2000000"` = 2 tokens |

  **Response**

  ```json
  {
    "amountOut":         "2298969",
    "amountOutMin":      "2275979",
    "fee":               30,
    "protocolFeeBps":    0,
    "protocolFeeAmount": "0",
    "amountOutAfterFee": "2298969",
    "poolAddress":       "0xFDF5139b38525627B47538536042A7c8d2686BD9",
    "stable":            false,
    "relayerAddress":    "0xdb5019b8DfbccEF8906C39B16a4870082eAbBc4C"
  }
  ```

  - `fee` — Aerodrome pool fee in bps (30 = 0.3% volatile, 5 = 0.05% stable). Already embedded in `amountOut`.
  - `stable` — whether the best pool is the stable or volatile Aerodrome pool.
  - `relayerAddress` — the address the EIP-3009 authorization must name as `to`.

  ---

  ### POST /api/swap/execute

  Executes the gasless swap. Client must first obtain a quote and sign an EIP-3009 authorization.

  **Request body**

  ```json
  {
    "tokenIn":     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "tokenOut":    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    "amountIn":    "2000000",
    "owner":       "0xUserWalletAddress",
    "stable":      false,
    "validAfter":  "0",
    "validBefore": "1749240000",
    "nonce":       "0xrandom32bytes...",
    "v":           27,
    "r":           "0x...",
    "s":           "0x...",
    "slippageBps": 50
  }
  ```

  | Field | Notes |
  |---|---|
  | `stable` | Must match the `stable` field from the quote response |
  | `slippageBps` | 1–100 bps (0.01–1%). Default 50 (0.5%) |
  | `validBefore` | EIP-3009 expiry — the server also checks this before submitting |

  **Response**

  ```json
  {
    "txHash":            "0x7b4c9bcc...",
    "tokenIn":           "0x833589f...",
    "tokenOut":          "0x60a3E35...",
    "amountIn":          "2000000",
    "amountOutAfterFee": "2298969"
  }
  ```

  The swap transaction (`txHash`) is the Aerodrome Router call (TX2). TX1 (the `transferWithAuthorization`) is submitted and confirmed first but its hash is not returned — it can be found on Basescan by filtering the relay wallet's outbound transactions.

  **Error responses**

  | Code | Body | Meaning |
  |---|---|---|
  | 400 | `{ "error": "Only USDC↔EURC swaps are supported" }` | Unsupported token pair |
  | 400 | `{ "error": "EIP-3009 authorization has expired" }` | `validBefore` in the past |
  | 400 | `{ "error": "EIP-3009 authorization is not yet valid" }` | `validAfter` in the future |
  | 400 | `{ "error": "Insufficient token balance" }` | User wallet balance < `amountIn` |
  | 500 | `{ "error": "...", "refundHash": "0x..." }` | TX2 failed; tokens refunded to user |
  | 503 | `{ "error": "Relay wallet has insufficient ETH" }` | Relay needs top-up |

  ---

  ## On-Chain Addresses (Base Mainnet)

  | Name | Address |
  |---|---|
  | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
  | EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` |
  | Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
  | Aerodrome Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
  | EURC/USDC Volatile Pool | `0xFDF5139b38525627B47538536042A7c8d2686BD9` |
  | BasePay Relay Wallet | `0xdb5019b8DfbccEF8906C39B16a4870082eAbBc4C` |

  > **Note:** Uniswap V3 has zero USDC/EURC liquidity on Base. Aerodrome is the only active venue for this pair.

  ---

  ## Security Model

  ### What the relay can and cannot do

  The relay wallet receives tokens between TX1 and TX2, but it is **constrained by the EIP-3009 signature**:

  - The signature binds: `from` (user), `to` (relay), `value` (exact amount), `nonce` (one-time), `validBefore` (expiry).
  - The relay cannot replay the authorization (USDC enforces `authorizationState` on-chain).
  - The relay cannot change the destination of the swap — TX2 hardcodes `to = owner` (the user's wallet address from the request body) directly in the router call.
  - If TX2 fails, the relay has automatic refund logic: it calls `token.transfer(user, amountIn)` to return the tokens.

  ### Pre-submission validation

  Before submitting any transaction, the server checks:

  1. Token pair is USDC↔EURC (whitelist enforced)
  2. `amountIn` is within bounds (1 to 10,000 tokens)
  3. `validBefore` is in the future; `validAfter` is in the past
  4. `slippageBps` is at least 1 (prevents zero-slippage locks)
  5. Relay wallet holds ≥ 0.001 ETH (prevents mid-flow failures)
  6. User wallet has sufficient balance of `tokenIn`
  7. Aerodrome pool returns a non-zero quote at the requested amount

  ### Slippage protection

  The `amountOutMin` passed to the router is calculated server-side from a fresh quote at execution time — not from the quote response the client cached. This prevents front-running via stale quote replay.

  ---

  ## Known Issues Fixed During Development

  Three independent bugs caused TX2 failures during development. All are fixed in production.

  ### 1. Server clock drift → `Expired()` error

  **Symptom:** TX2 reverted with custom error selector `0x203d82d8` (`Expired()`).

  **Root cause:** The Replit production server's `Date.now()` runs significantly behind Base mainnet's `block.timestamp`. With a 5-minute deadline, the router saw `block.timestamp > deadline` during simulation.

  **Fix:** Deadline set to `now + 7200s` (2 hours). The EIP-3009 `validBefore` window is the real security guard against stale swaps.

  ---

  ### 2. `eth_estimateGas` false-revert → unknown reversion

  **Symptom:** TX2 produced `"execution reverted for an unknown reason"` immediately after TX1 confirmed.

  **Root cause:** viem calls `eth_estimateGas` before submitting a transaction. This simulation runs against the *pending block state* — which does not yet include TX1's confirmed state. The RPC node sees zero `tokenIn` balance at the relay, so the router's `transferFrom` call fails. The error decodes as "unknown reason" because the router's custom error selector (`InsufficientInputAmount` or similar) is absent from our ABI.

  **Fix:**
  - Set `gas: 350_000n` explicitly on the TX2 `writeContract` call. This bypasses `eth_estimateGas` entirely.
  - Added a 1.5-second delay between TX1 receipt and TX2 submission so the RPC node's state index can catch up.
  - On-chain execution uses the canonical confirmed state (TX1 is in a block), so TX2 succeeds.
  - 350k is well above the actual ~200–270k gas a single-hop Aerodrome volatile swap uses.

  ---

  ### 3. Production proxy timeout → HTTP 500

  **Symptom:** The deployed app returned `HTTP 500 : Internal Server Error` on large or slow swaps, even when both transactions succeeded on-chain.

  **Root cause:** The original handler waited for TX2's receipt (`waitForTransactionReceipt`) inside the HTTP request. Combined TX1 + TX2 confirmation time (10–20s) exceeded Replit's production proxy timeout. The proxy killed the connection and returned a generic 500 with an empty body.

  **Fix:** Return the TX2 hash immediately after submission — do not wait for the receipt. Base typically confirms in ~2 seconds. If TX2 reverts on-chain (rare, since `amountOutMin` is server-validated), tokens remain at the relay and the operator refunds manually.

  ---

  ## Confirmed Live Transactions

  These two transactions confirm the swap working correctly on Base Mainnet:

  | Direction | Amount | TX Hash | Block |
  |---|---|---|---|
  | EURC → USDC | 2 EURC → 2.298969 USDC | [`0x7b4c9bcc...`](https://basescan.org/tx/0x7b4c9bcc2c8443c7c69b9fc21a96847bcbdf161283a5a5aa8c60fc8161c807cb) | 47054904 |
  | USDC → EURC | 2 USDC → 1.730052 EURC | [`0xc19b0154...`](https://basescan.org/tx/0xc19b01544385ac3e933ae4506f2a420e4f714f63636636b8f5830f995f1b43fc) | 47055015 |

  Both transactions: 350,000 gas set, ~57–77% consumed, Aerodrome volatile pool, 0.3% pool fee to Aerodrome's fee collector.
  