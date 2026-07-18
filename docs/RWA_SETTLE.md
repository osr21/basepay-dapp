# RWA Swap-and-Settle

BasePay's **RWA Settle** page lets users pay invoices or settle obligations using yield-bearing **Real World Asset (RWA) tokens** — the recipient always receives **USDC**. The swap is routed on-chain through [Aerodrome Finance](https://aerodrome.finance) on Base.

**Live:** [basepay.replit.app/rwa-settle](https://basepay.replit.app/rwa-settle)

---

## Overview

| Parameter | Value |
|---|---|
| Supported input tokens | cbBTC · wstETH |
| Output token | USDC |
| DEX | Aerodrome Finance (Volatile AMM, v1) |
| Route | `token → WETH → USDC` (2-hop) |
| ETH cost | User pays gas (~150–700k gas) |
| Slippage tolerance | 2% |
| Approvals | Max approval (one-time per token) |
| Transactions | 1 (swap only) or 2 (approve + swap) |

---

## Supported Tokens

| Token | Symbol | Contract Address | Decimals | Description |
|---|---|---|---|---|
| Coinbase Wrapped Bitcoin | cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | BTC wrapped by Coinbase, redeemable 1:1 |
| Lido Wrapped Staked ETH | wstETH | `0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452` | 18 | Yield-bearing staked ETH from Lido |

---

## How It Works

```
User                          Base Mainnet
 │                                 │
 │─ 1. approve (if needed) ───────▶│ token.approve(AerodromeRouter, MAX)
 │                                 │
 │─ 2. swapExactTokensForTokens ──▶│ AerodromeRouter
 │   (token → WETH → USDC)         │   → pool1: token/WETH
 │   recipient = payment address   │   → pool2: WETH/USDC
 │                                 │
 │◀─ USDC lands in recipient ───────│
```

1. User connects an EOA wallet (any injected wallet or WalletConnect).
2. User enters amount of cbBTC or wstETH to sell.
3. The page fetches a live on-chain quote via `AerodromeRouter.getAmountsOut(amountIn, routes)`.
4. User enters the recipient address (who will receive USDC).
5. If first use: **Transaction 1** — `token.approve(AerodromeRouter, MAX_UINT256)` — one-time per token.
6. **Transaction 1 or 2** — `AerodromeRouter.swapExactTokensForTokens(amountIn, amountOutMin, routes, recipient, deadline)`.
7. USDC is delivered directly to the recipient — no intermediate custody.

---

## Swap Routes

Both routes use a 2-hop path through WETH (the native Base bridge token). Aerodrome volatile pools are used for all hops.

### cbBTC → USDC

```
cbBTC (8 dec)
  └─▶ cbBTC/WETH volatile pool  (Aerodrome factory)
        └─▶ WETH
              └─▶ WETH/USDC volatile pool  (Aerodrome factory)
                    └─▶ USDC (6 dec)
```

### wstETH → USDC

```
wstETH (18 dec)
  └─▶ wstETH/WETH volatile pool  (Aerodrome factory)
        └─▶ WETH
              └─▶ WETH/USDC volatile pool  (Aerodrome factory)
                    └─▶ USDC (6 dec)
```

---

## Contract Addresses

| Contract | Address |
|---|---|
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Aerodrome Pool Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| WETH (Base) | `0x4200000000000000000000000000000000000006` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

---

## On-Chain Quote

The price quote is fetched in real time from the Aerodrome Router's view function:

```ts
// wagmi useReadContract hook
const { data: quoteRaw } = useReadContract({
  address:      "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  abi:          AERODROME_GET_AMOUNTS_OUT_ABI,
  functionName: "getAmountsOut",
  args:         [amountIn, routes],
  query:        { enabled: amountIn > 0n, staleTime: 10_000, refetchInterval: 15_000 },
});

// routes for cbBTC → WETH → USDC
const routes = [
  { from: cbBTC,  to: WETH, stable: false, factory: AERODROME_FACTORY },
  { from: WETH,   to: USDC, stable: false, factory: AERODROME_FACTORY },
];

// quoteRaw = [amountIn, wethAmount, usdcAmount]
const usdcOut = (quoteRaw as bigint[])[2]; // index 2 = final hop output
```

The quote refreshes every 15 seconds. If pools have insufficient liquidity, `getAmountsOut` returns 0 for that hop and the swap button is disabled.

---

## Swap Call

```ts
const swapHash = await writeContractAsync({
  address:      AERODROME_ROUTER,
  abi:          AERODROME_SWAP_ABI,
  functionName: "swapExactTokensForTokens",
  args: [
    amountIn,      // uint256 — atomic units of input token
    amountOutMin,  // uint256 — 98% of quoted USDC (2% slippage)
    routes,        // Route[] — [{from, to, stable, factory}, ...]
    recipient,     // address — receives USDC directly
    deadline,      // uint256 — now + 600 seconds
  ],
  gas: 700_000n,   // explicit cap bypasses eth_estimateGas which false-reverts on Base RPC
});
```

### Aerodrome Route Struct ABI

```ts
const AERODROME_SWAP_ABI = [{
  type: "function",
  name: "swapExactTokensForTokens",
  stateMutability: "nonpayable",
  inputs: [
    { name: "amountIn",     type: "uint256" },
    { name: "amountOutMin", type: "uint256" },
    {
      name: "routes", type: "tuple[]",
      components: [
        { name: "from",    type: "address" },
        { name: "to",      type: "address" },
        { name: "stable",  type: "bool"    },
        { name: "factory", type: "address" },  // required — must not be zero address
      ],
    },
    { name: "to",       type: "address" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [{ name: "amounts", type: "uint256[]" }],
}];
```

> **Important:** The Aerodrome v2 `Route` struct requires a `factory` field. Passing `address(0)` will cause the router to fail. Always pass the pool factory address: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`.

---

## Slippage and Gas

### Slippage

RWA tokens (cbBTC, wstETH) can have wider bid-ask spreads in AMM pools than pure stablecoin pairs. The default slippage tolerance is **2%** (200 basis points):

```ts
const slippageBps  = 200n;
const amountOutMin = (quotedUsdcOut * (10_000n - slippageBps)) / 10_000n;
```

If price moves more than 2% between quote and execution, the swap is rejected by the router with `INSUFFICIENT_OUTPUT_AMOUNT`.

### Gas

`eth_estimateGas` can return inflated values on Base RPC for Aerodrome calls. An explicit gas cap of **700,000** is passed to bypass estimation:

```ts
gas: 700_000n
```

Typical observed gas is 150,000–400,000. Unused gas is refunded.

---

## Frontend Guards

The **Swap & Settle** button is disabled until all preconditions are met:

| Condition | Check |
|---|---|
| Wallet connected | `isConnected` |
| Base Mainnet | `chain?.id === base.id` |
| Amount > 0 | `amountBig > 0n` |
| Balance loaded and sufficient | `balance !== undefined && amountBig <= balance` |
| Live quote > 0 | `quotedUsdcOut > 0n` |
| Valid recipient address | `isAddress(recipient)` |
| Not sending to self | `recipient !== address` |

Displaying "Insufficient cbBTC balance" or "No liquidity for this amount" inline prevents the doomed transaction from ever being submitted.

---

## Error Handling

| Error | User-Facing Message |
|---|---|
| `0x2105` / exceeds max transaction gas | "Swap failed: the pool may have insufficient liquidity for this amount. Try a smaller amount or try again later." |
| `INSUFFICIENT_OUTPUT_AMOUNT` | "Swap failed: price moved too much (slippage). Please try again." |
| `transfer amount exceeds balance` | "Insufficient `<token>` balance." |
| User rejected | (silently dismissed, no error shown) |

---

## Extending to Other Tokens

To add a new RWA token to the swap UI:

1. Verify it has an Aerodrome volatile pool against WETH (or a direct USDC pool).
2. Add an entry to `RWA_TOKENS` in `artifacts/base-pay/src/lib/wagmi.ts`:

```ts
{
  address:  "0x...",
  symbol:   "TOKEN",
  name:     "Token Name",
  decimals: 18,
  flag:     "🏦",
  route: [
    { from: TOKEN_ADDRESS, to: WETH,  stable: false, factory: AERODROME_FACTORY },
    { from: WETH,          to: USDC,  stable: false, factory: AERODROME_FACTORY },
  ],
  outIdx: 2,  // index into getAmountsOut result array for final USDC amount
}
```

3. Add the token address to `contracts/addresses.json` for reference.
4. No backend changes required — the swap is fully on-chain.

---

## Comparison with Gasless Swap

| | Gasless Swap (`/swap`) | RWA Settle (`/rwa-settle`) |
|---|---|---|
| **Input tokens** | USDC, EURC | cbBTC, wstETH |
| **Output token** | EURC or USDC | USDC (always) |
| **ETH required** | **No** (relayer pays) | **Yes** (user pays) |
| **Custody** | Tokens go through relayer temporarily | Direct wallet → router → recipient |
| **Route** | Aerodrome stable pool | Aerodrome volatile 2-hop |
| **Recipient** | Same wallet (swap-in-place) | Any address (payment flow) |
