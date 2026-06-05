# BasePay V2 — Smart Contract Integration Guide

Open, permissionless payment infrastructure on **Base Mainnet**. All four contracts are source-verified on Basescan, immutable, and free to integrate.

## Deployed Contracts

| Contract | Address | Basescan |
|---|---|---|
| **BasePayRouterV2** | `0x756f516cdf5eb98e140eba44119b22fc0f0bb63f` | [View ↗](https://basescan.org/address/0x756f516cdf5eb98e140eba44119b22fc0f0bb63f#code) |
| **BatchPayV2** | `0xe40d2292c050566d16cecda74627b70778806c68` | [View ↗](https://basescan.org/address/0xe40d2292c050566d16cecda74627b70778806c68#code) |
| **EscrowV2** | `0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499` | [View ↗](https://basescan.org/address/0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499#code) |
| **SubscriptionManagerV2** | `0x101918a252b3852ac4b50b7bbf2525d3084d5421` | [View ↗](https://basescan.org/address/0x101918a252b3852ac4b50b7bbf2525d3084d5421#code) |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [View ↗](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

> **Audit:** see [`AUDIT.md`](./AUDIT.md). No high findings. Medium finding is accepted-by-design (unrestricted `charge()` on SubscriptionManagerV2 cannot cause fund loss due to the interval guard).

---

## Files in this directory

```
contracts/
├── addresses.json               ← Machine-readable addresses + metadata
├── AUDIT.md                     ← Slither static analysis report (2026-06-04)
│
├── BasePayRouterV2.sol/.json    ← Single USDC payment with protocol fee
├── BatchPayV2.sol/.json         ← Up to 200 recipients in one transaction
├── EscrowV2.sol/.json           ← Time-locked escrow with release/refund
├── SubscriptionManagerV2.sol    ← On-chain recurring payments
│   └── SubscriptionManagerV2.json
│
└── integration/
    ├── viem.ts                  ← viem v2 examples
    ├── ethers.ts                ← ethers.js v6 examples
    └── wagmi.tsx                ← wagmi v2/v3 + React hooks
```

---

## Contract Summaries

### BasePayRouterV2
Sends ERC-20 from sender → recipient with a protocol fee split.

- **`send(token, recipient, amount, memo)`** — requires prior `approve()` or `transferFrom` allowance
- **`sendWithPermit(token, recipient, amount, memo, deadline, v, r, s)`** — atomic: permit + transfer in one tx (recommended)
- **`quote(amount)`** → `(feeAmount, netAmount)` — preview fee before sending
- Emits `Payment(sender, recipient, token, grossAmount, feeAmount, netAmount, memo)`
- Fee: **0.30%** (30 bps), capped at 10% by contract

### BatchPayV2
Sends ERC-20 to up to **200 recipients** in one transaction.

- **`batchSend(token, recipients[], amounts[], memo)`** — requires prior allowance
- **`batchSendWithPermit(..., permitAmount, deadline, v, r, s)`** — sign once, pay all
- **`quoteBatch(amounts[])`** → `(totalGross, totalFee, totalNet)` — preview totals

### EscrowV2
Locks ERC-20 until the payer releases or refunds after TTL expires.

- **`create(token, payee, amount, ttl, memo)`** → `id` — create and fund an escrow
- **`createWithPermit(..., deadline, v, r, s)`** → `id` — gasless approve + create
- **`release(id)`** — payer releases funds to payee (before expiry)
- **`refund(id)`** — payer reclaims funds (after TTL expires)
- Emits `EscrowCreated(id, payer, payee, token, amount, expiry, memo)`
- Fee collected on release, not on creation

### SubscriptionManagerV2
On-chain recurring ERC-20 charges at fixed intervals.

- **`subscribe(token, payee, amount, interval, memo)`** → `id` — requires prior allowance
- **`subscribeWithPermit(..., permitAmount, deadline, v, r, s)`** → `id` — recommended
- **`charge(id)`** — callable by **anyone** once per interval (automation-friendly)
- **`cancel(id)`** — callable by payer to stop future charges
- **`nextChargeAt(id)`** → UNIX timestamp of next eligible charge
- Emits `Subscribed(id, payer, payee, token, amount, interval, memo)`

---

## Quick Start

### 1. Load addresses

```ts
import addresses from "./addresses.json";
const ROUTER = addresses.contracts.BasePayRouterV2.address;
```

### 2. Choose your library

Copy-paste integration examples are in `integration/`:

| Library | File |
|---|---|
| **viem** | [`integration/viem.ts`](./integration/viem.ts) |
| **ethers.js v6** | [`integration/ethers.ts`](./integration/ethers.ts) |
| **wagmi (React)** | [`integration/wagmi.tsx`](./integration/wagmi.tsx) |

### 3. One-transaction payment (viem)

```ts
import { sendWithPermit } from "./integration/viem";

const txHash = await sendWithPermit(
  "0xYourAddress",
  "0xRecipientAddress",
  "10.00",       // USDC amount
  "Invoice #42", // memo
);
```

### 4. Batch pay 50 wallets (ethers.js)

```ts
import { batchPay } from "./integration/ethers";

await batchPay(signer, [
  { recipient: "0xAlice...", amountUsdc: "25.00" },
  { recipient: "0xBob...",   amountUsdc: "15.00" },
  // ... up to 200
], "Payroll March");
```

### 5. Create a 7-day escrow (wagmi)

```tsx
import { useCreateEscrow } from "./integration/wagmi";

const { createEscrow, txHash, isSuccess } = useCreateEscrow();

await createEscrow(
  "0xPayee...",
  "100.00",          // USDC
  7 * 24 * 3600,     // TTL: 7 days
  "Service delivery escrow",
);
```

### 6. Set up a monthly subscription (wagmi)

```tsx
import { useSubscribe } from "./integration/wagmi";

const { subscribe, isSuccess } = useSubscribe();

await subscribe(
  "0xMerchant...",
  "9.99",        // USDC per month
  "monthly",
  "SaaS subscription",
);
```

### 7. Automate subscription charging (backend)

```ts
import { chargeSubscription } from "./integration/ethers";

// Run via cron / keeper network — callable by anyone once per interval
await chargeSubscription(signer, subscriptionId);
```

---

## Critical Integration Notes

### ⚠ Always guard the active network

A mismatched `chainId` in the EIP-712 domain causes wallets like Rabby to throw
`"chainId should be same as current chainId"` *before* the signing popup appears.
Add a network guard before any signing flow:

```tsx
// wagmi
const chainId = useChainId();
const { switchChain } = useSwitchChain();

if (chainId !== base.id) {
  return <button onClick={() => switchChain({ chainId: base.id })}>Switch to Base</button>;
}
```

The `WrongNetworkGuard` component in `integration/wagmi.tsx` is ready to drop in.

### ⚠ Do NOT use maxUint256 permits for subscriptions

Signing a permit for `maxUint256` with a far-future deadline gives the
SubscriptionManager permanent unlimited access to the user's USDC. If the contract
is ever exploited, all users with such permits can be fully drained.

**Always cap the permit amount** — the integration examples use `amount × 1,000`
(enough for thousands of billing cycles) with a **3-year deadline**.

### ⚠ EIP-2612 permit domain for USDC on Base

```ts
{
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
}
```

The `version: "2"` field is required. Omitting it produces a valid-looking signature that USDC rejects on-chain.

### ⚠ MetaMask / Blockaid warnings on new integrations

Newly deployed contracts that haven't been indexed by Blockaid's off-chain database
will show a "this dApp is not trusted" warning in MetaMask on every EIP-712 signing
dialog — even if the contract is source-verified on Basescan. The two systems are
independent.

**Resolution:** Submit your contracts at [account.blockaid.io](https://account.blockaid.io).
Rabby Wallet reads contract source directly from the block explorer and does not
show this warning for verified contracts.

---

## Fee Model

All V2 contracts charge **0.30%** (30 bps) on every transfer. Fee is split automatically.

| Gross | Fee (0.30%) | Recipient receives |
|---|---|---|
| 10 USDC | 0.03 USDC | 9.97 USDC |
| 100 USDC | 0.30 USDC | 99.70 USDC |
| 1,000 USDC | 3.00 USDC | 997.00 USDC |

Call `quote(amount)` or `quoteBatch(amounts[])` on-chain to get exact values before
submitting a transaction.

---

## Deploying Your Own Instance

All contracts take `(feeCollector, feeBps)` constructor args. Deploy with Foundry:

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Deploy BasePayRouterV2
forge create \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PRIVATE_KEY \
  contracts/BasePayRouterV2.sol:BasePayRouterV2 \
  --constructor-args 0xYourFeeCollector 30

# Verify on Basescan (use Etherscan V2 API with chainid=8453 in URL query)
forge verify-contract <ADDRESS> \
  contracts/BasePayRouterV2.sol:BasePayRouterV2 \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=8453" \
  --etherscan-api-key $BASESCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint256)" 0xYourFeeCollector 30)
```

> The `chainid` param must be in the **URL query string**, not the POST body. See `AUDIT.md` for details.

---

## Links

- **dApp:** [basepay.replit.app](https://basepay.replit.app)
- **GitHub:** [github.com/osr21/basepay-dapp](https://github.com/osr21/basepay-dapp)
- **USDC (Base):** [Circle's official docs](https://developers.circle.com/stablecoins/usdc-on-test-networks)
- **EIP-2612 Permit:** [eips.ethereum.org/EIPS/eip-2612](https://eips.ethereum.org/EIPS/eip-2612)
- **EIP-3009 TransferWithAuthorization:** [eips.ethereum.org/EIPS/eip-3009](https://eips.ethereum.org/EIPS/eip-3009)
