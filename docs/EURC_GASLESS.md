# EURC Gasless Transfer

BasePay's gasless relayer supports **both USDC and EURC** on Base Mainnet. Users sign a single off-chain EIP-3009 message; the relayer pays the ETH gas and submits `transferWithAuthorization` on their behalf.

**Live:** [basepay.replit.app/gasless](https://basepay.replit.app/gasless)

---

## Overview

| Parameter | Value |
|---|---|
| Supported tokens | USDC · EURC |
| Standard | EIP-3009 `TransferWithAuthorization` |
| ETH cost to user | **$0.00** |
| Signatures required | **1** (off-chain typed data) |
| Maximum relay amount | 1,000,000 tokens |
| Authorization window | Up to 30 minutes |

---

## How It Works

```
User                        BasePay API                  Base Mainnet
 │                               │                            │
 │─ select token (USDC / EURC) ─▶│                            │
 │─ sign EIP-3009 message ──────▶│                            │
 │  (off-chain, zero gas)        │                            │
 │                               │─ validate sig & balance ──▶│
 │                               │─ transferWithAuthorization▶│ token contract
 │                               │  (relayer pays ETH gas)    │
 │◀─────────────── txHash ───────│◀────────── receipt ────────│
```

1. User selects **USDC** or **EURC** on the Gasless Transfer page.
2. Client fetches the relayer address from `GET /api/gasless/fee`.
3. User signs an EIP-3009 typed-data message with `to = relayerAddress`.
4. Client posts the signature to `POST /api/gasless/transfer` with `token = <address>`.
5. API validates balance and replay protection, then calls `token.transferWithAuthorization(...)` paying the gas itself.

---

## EIP-712 Domains

USDC and EURC have **different** EIP-712 domain separators — using the wrong one produces an invalid signature.

### USDC

```ts
const domain = {
  name:              "USD Coin",
  version:           "2",
  chainId:           8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
```

### EURC

```ts
const domain = {
  name:              "EURC",      // returned by EURC.name() on Base
  version:           "2",
  chainId:           8453,
  verifyingContract: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
};
```

> **Note:** EURC on Base returns `"EURC"` from its `name()` function — not `"EUR Coin"` or `"Euro Coin"`. Using the wrong string produces a domain separator mismatch and will fail `ecrecover` on-chain.

The `TransferWithAuthorization` type is identical for both tokens:

```ts
const types = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};
```

---

## API Reference

### GET /api/gasless/fee

Returns relayer status and address. Pass this address as `to` when signing.

```
GET /api/gasless/fee
→ {
    "relayFeeUsdc": "0.00",
    "relayerReady": true,
    "relayerEthBalance": "0.05",
    "networkName": "Base Mainnet",
    "relayerAddress": "0xdb5019b8DfbccEF8906C39B16a4870082eAbBc4C"
  }
```

### POST /api/gasless/transfer

```
POST /api/gasless/transfer
Content-Type: application/json

{
  "from":        "0xSenderAddress",
  "to":          "0xRecipientAddress",
  "value":       "10000000",
  "validAfter":  "0",
  "validBefore": "1749232000",
  "nonce":       "0x<random 32 bytes>",
  "v": 27,
  "r": "0x...",
  "s": "0x...",
  "token":       "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"
}
```

The `token` field is optional — it defaults to USDC. Set it to the EURC contract address to relay an EURC transfer.

```
→ 200 { "txHash": "0x...", "from": "0x...", "to": "0x...", "value": "10000000" }
→ 400 { "error": "Unsupported token" }
→ 400 { "error": "Nonce already used" }
→ 400 { "error": "Insufficient EURC balance" }
→ 500 { "error": "Relayer not configured" }
```

---

## Token Addresses

| Token | Address | Decimals |
|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 |

---

## Client-Side Signing Example

```ts
import { useWalletClient } from "wagmi";
import { keccak256, toBytes, encodePacked } from "viem";

const EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";

const { data: walletClient } = useWalletClient();

const nonce = keccak256(toBytes(crypto.randomUUID()));
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min

const signature = await walletClient.signTypedData({
  domain: {
    name:              "EURC",
    version:           "2",
    chainId:           8453,
    verifyingContract: EURC,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from:        userAddress,
    to:          relayerAddress,     // from GET /api/gasless/fee
    value:       amountInAtomicUnits,
    validAfter:  0n,
    validBefore,
    nonce,
  },
});

// POST to relay
await fetch("/api/gasless/transfer", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: userAddress,
    to:   recipientAddress,         // actual recipient (relayer forwards internally)
    value: amountInAtomicUnits.toString(),
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce,
    v: Number(signature.slice(-2)),
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    token: EURC,
  }),
});
```

---

## Backend Configuration

The server-side allowlist is in `artifacts/api-server/src/routes/gasless.ts`:

```ts
const ALLOWED_TOKENS: Record<string, { name: string; decimals: number }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USDC", decimals: 6 },
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { name: "EURC", decimals: 6 },
};
```

Any token not present in this map is rejected with `400 Unsupported token`. To add a new EIP-3009 token:

1. Verify it implements `transferWithAuthorization` (EIP-3009).
2. Verify the EIP-712 `name()` and `version` values from the on-chain contract.
3. Add an entry to `ALLOWED_TOKENS`.
4. Add the domain to `GASLESS_TOKENS` in the frontend (`artifacts/base-pay/src/pages/GaslessTransfer.tsx`).

---

## Replay Protection

Nonces are checked in three layers:
1. **In-memory set** — immediate duplicate rejection within the same process
2. **PostgreSQL** — persisted nonce log across restarts
3. **On-chain** — `IERC3009.authorizationState(from, nonce)` — final source of truth

A used nonce cannot be replayed even after a server restart.

---

## Wallet Compatibility

EIP-3009 relies on `ecrecover` — only **EOA (Externally Owned Account)** signatures are valid. Smart contract wallets (Coinbase Smart Wallet with Passkeys, Safe, Argent) produce EIP-1271 signatures that are incompatible with the USDC/EURC on-chain check. Use the [Smart Wallet Pay](/smart-wallet) page instead for sponsored gasless transactions with smart wallets.
