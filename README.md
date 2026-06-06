# BasePay — USDC Payments on Base

Open-source USDC payment infrastructure on **Base Mainnet**. Four verified smart contracts, a gasless transfer relayer, and a full React dApp — all permissionless and free to fork or integrate.

**Live:** [basepay.replit.app](https://basepay.replit.app) &nbsp;·&nbsp; **Chain:** Base Mainnet (chainId 8453) &nbsp;·&nbsp; **Token:** USDC

---

## Features

| Feature | Description |
|---|---|
| **Send** | USDC transfer via approve→transfer or EIP-2612 permit (one tx) |
| **Gasless Transfer** | User signs off-chain (EIP-3009); relayer pays the ETH gas — user pays zero |
| **Batch Pay** | Up to 200 recipients in a single transaction |
| **Escrow** | Time-locked USDC with release / refund |
| **Subscriptions** | On-chain recurring charges at fixed intervals |
| **Payment Requests** | Shareable links that pre-fill recipient and amount |
| **Basenames** | Forward-resolves `.base.eth` names throughout the dApp |
| **Coinbase Smart Wallet** | First-class ERC-4337 smart wallet support with identity badge |
| **EAS Verification** | Coinbase attestation badge on verified accounts via EAS |
| **x402 Relay API** | Micro-payment–gated developer relay endpoint (x402 protocol) |
| **OnchainKit** | Buy USDC button and identity components via Coinbase OnchainKit |

---

## Gasless Transfer

The gasless flow lets a user send USDC **without holding any ETH**. The user signs a message in their wallet; a server-side relayer pays the gas and submits the transaction on their behalf.

### How it works

```
User                        BasePay API                  Base Mainnet
 │                               │                            │
 │─ sign EIP-3009 message ──────▶│                            │
 │  (off-chain, zero gas)        │                            │
 │                               │─ validate sig & balance ──▶│
 │                               │                            │
 │                               │─ transferWithAuthorization▶│ USDC contract
 │                               │  (relayer pays ETH gas)    │
 │                               │                            │
 │◀─────────────── txHash ───────│◀────────── receipt ────────│
```

1. **User signs** an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` typed message — off-chain, no ETH, no wallet transaction.
2. **Client posts** the signature + parameters to `POST /api/gasless/transfer`.
3. **API validates** the request: timing window, USDC balance, and replay protection (in-memory nonce guard → DB check → on-chain `authorizationState`).
4. **Relayer submits** `USDC.transferWithAuthorization(from, to, value, ...)` — paying the Base gas fee from its own ETH balance.
5. **USDC moves** directly from the user's wallet to the recipient. The relayer never holds the funds.

### Smart wallet compatibility

> **Note:** EIP-3009 gasless transfers require an **EOA (externally owned account)** signature. Smart contract wallets (Coinbase Smart Wallet with Passkeys, Safe, etc.) return signature formats incompatible with USDC's on-chain `ecrecover` check. The dApp detects smart wallets via `eth_getCode` and shows a clear warning before users attempt to sign.

### Relay fee

**Free — 0 USDC.** The relayer covers gas out of the protocol's ETH balance. Gas on Base is typically < $0.01 per transfer.

### Limits

| Parameter | Value |
|---|---|
| Maximum relay amount | 1,000,000 USDC |
| Authorization window | Up to 30 minutes (configurable) |
| Replay protection | DB nonce cache + on-chain `authorizationState` |

### EIP-3009 signature (client-side)

```ts
// Sign off-chain — no wallet transaction, no ETH required
const sig = await walletClient.signTypedData({
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
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
  message: { from, to, value, validAfter: 0n, validBefore, nonce },
});
```

### Relayer API

```
POST /api/gasless/transfer
Content-Type: application/json

{
  "from":        "0xSenderAddress",
  "to":          "0xRecipientAddress",
  "value":       "10000000",        // atomic units (6 decimals), e.g. 10 USDC
  "validAfter":  "0",               // UNIX timestamp
  "validBefore": "1749232000",      // UNIX timestamp
  "nonce":       "0xrandom32bytes",
  "v": 27,
  "r": "0x...",
  "s": "0x..."
}

→ 200 { "txHash": "0x...", "from": "0x...", "to": "0x...", "value": "10000000" }
→ 400 { "error": "Nonce already used" }
→ 400 { "error": "Insufficient USDC balance" }
→ 500 { "error": "Relayer not configured" }
```

Check relayer status:
```
GET /api/gasless/fee
→ { "relayFeeUsdc": "0.00", "relayerReady": true, "relayerEthBalance": "0.05", "networkName": "Base Mainnet" }
```

### Running your own relayer

The relayer is the API server in this repo. It needs one funded ETH wallet:

```bash
# .env (api-server)
DEPLOYER_PRIVATE_KEY=0xYourPrivateKey   # must hold ETH on Base for gas
DATABASE_URL=postgres://...             # for nonce replay cache
```

Top up the relayer address with a small amount of ETH on Base (~0.05 ETH covers thousands of transfers at current gas prices). The relayer address is derived from `DEPLOYER_PRIVATE_KEY` — it never holds user USDC.

### Why EIP-3009 and not EIP-2612?

| | EIP-2612 (Permit) | EIP-3009 (TransferWithAuthorization) |
|---|---|---|
| **What it authorises** | A spender to pull funds later | A specific transfer of a specific amount |
| **Used for** | Gasless approve → contract pulls | Gasless send → relayer pushes |
| **Replay risk** | Spender can pull at any time within deadline | One-time: nonce + `authorizationState` prevents replay |
| **Best for** | Contracts that need allowance (Router, Escrow) | Direct user-to-user or user-to-contract transfers |

BasePay uses **both**: EIP-2612 permit for Router/Escrow/Batch/Subscription contract calls, and EIP-3009 for the gasless peer-to-peer relayer.

---

## Coinbase Smart Wallet & EAS Identity

### Smart Wallet connector

BasePay adds the Coinbase Smart Wallet as a first-class connector using wagmi's `coinbaseWallet` with `preference: { options: "all" }`, allowing users to connect with either a smart wallet (ERC-4337) or a standard EOA.

```ts
// artifacts/base-pay/src/lib/wagmi.ts
export const cbSmartWalletConnector = coinbaseWallet({
  appName: "BasePay",
  preference: { options: "all" }, // shows both Smart Wallet and EOA options
});
```

A **smart wallet badge** appears next to the connected address in the navigation bar when `connector.id === "coinbaseWalletSDK"`.

### EAS attestation badge

The `useCoinbaseAttestation` hook reads attestations directly from the [Ethereum Attestation Service](https://attest.org) contract deployed on Base:

| Address | Contract |
|---|---|
| `0x4200000000000000000000000000000000000021` | EAS (Base Mainnet) |
| `0x4200000000000000000000000000000000000020` | EAS Schema Registry |
| `0x357458739F90461b99789350868CD7CF330Dd7EE` | Coinbase Attester |

Two attestation levels are detected:

- **Coinbase Verified Account** — schema `0xf8b05c79f090979bf4a80270aba232dff11a10d9ba197028d67b11b18d87420`
- **Coinbase One** — schema `0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839522f4b5a47a74`

The badge (`✓ CB One` or `✓ Coinbase`) appears inline in the `WalletName` component anywhere an address is displayed (navigation, send form, transaction receipts).

---

## x402 Premium Relay API

BasePay exposes a **micro-payment–gated** relay endpoint using the [x402 protocol](https://www.x402.org). Callers include a USDC micro-payment header alongside their request; the server verifies and settles it automatically before relaying.

### Endpoints

```
GET /api/v2/relay/info
→ {
    "version": "v2",
    "protocol": "x402",
    "price": "$0.001",
    "network": "eip155:8453",
    "payTo": "0x...",
    "facilitator": "https://x402.org/facilitator",
    "description": "Gasless USDC relay — BasePay developer API",
    "docs": "https://www.x402.org"
  }

POST /api/v2/relay                        ← requires x402 payment header
X-Payment: <x402-signed-payment-header>
Content-Type: application/json

{ "from": "0x...", "to": "0x...", "value": "...", ... }  // same as /api/gasless/transfer
```

### How x402 works

```
Client                      BasePay API               x402 Facilitator
 │                               │                            │
 │── POST /api/v2/relay ────────▶│                            │
 │   (no payment header)         │                            │
 │                               │                            │
 │◀── 402 Payment Required ──────│                            │
 │    (payment requirements)     │                            │
 │                               │                            │
 │── POST /api/v2/relay ────────▶│                            │
 │   X-Payment: <signed header>  │── verify payment ─────────▶│
 │                               │◀── verified ───────────────│
 │                               │── settle ─────────────────▶│
 │                               │── relay transaction ───────│──▶ Base
 │◀── 200 { txHash } ────────────│                            │
```

### Configuration

Set `FEE_COLLECTOR_ADDRESS` in the API server environment to enable the payment gate. If unset, the middleware is bypassed and the relay is open.

```bash
FEE_COLLECTOR_ADDRESS=0xYourAddress   # receives the 0.001 USDC micro-payment
```

### Facilitator note

The public x402 facilitator at `https://x402.org/facilitator` currently supports **Base Sepolia (`eip155:84532`) only**. For production Base Mainnet (`eip155:8453`) usage, configure a Coinbase CDP or self-hosted facilitator. When the public facilitator doesn't support the configured network, the endpoint returns `503` with an actionable error message (the status is cached in-process to avoid re-querying on every request).

---

## OnchainKit

BasePay integrates [Coinbase OnchainKit](https://onchainkit.xyz) for onramp and identity UI components.

The `OnchainKitProvider` wraps the entire React app:

```tsx
<OnchainKitProvider
  apiKey={import.meta.env.VITE_CDP_API_KEY}
  chain={base}
  config={{ appearance: { mode: "dark" } }}
>
  {/* app */}
</OnchainKitProvider>
```

The Dashboard shows a **Buy USDC** button (`FundButton` from OnchainKit) that opens Coinbase Pay directly inside the dApp.

> **Compatibility note:** OnchainKit 1.x imports from `wagmi/experimental` which was removed in wagmi v3. A `wagmi-experimental-shim.ts` stub re-exports the required symbols (`useConnect`, `useConnectors`) with a Vite alias, keeping OnchainKit functional without downgrading wagmi.

---

## Smart Contracts

All four contracts are source-verified on Basescan. See [`contracts/README.md`](./contracts/README.md) for full integration docs, ABIs, and copy-paste examples.

| Contract | Address | Basescan |
|---|---|---|
| BasePayRouterV2 | `0x756f516cdf5eb98e140eba44119b22fc0f0bb63f` | [↗](https://basescan.org/address/0x756f516cdf5eb98e140eba44119b22fc0f0bb63f#code) |
| BatchPayV2 | `0xe40d2292c050566d16cecda74627b70778806c68` | [↗](https://basescan.org/address/0xe40d2292c050566d16cecda74627b70778806c68#code) |
| EscrowV2 | `0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499` | [↗](https://basescan.org/address/0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499#code) |
| SubscriptionManagerV2 | `0x101918a252b3852ac4b50b7bbf2525d3084d5421` | [↗](https://basescan.org/address/0x101918a252b3852ac4b50b7bbf2525d3084d5421#code) |

Fee: **0.30%** on all contract payments. Relay fee: **free**.

---

## Tech Stack

- **Frontend:** React 19, Vite, wagmi v3, viem v2, TailwindCSS, Wouter
- **Wallet integration:** wagmi `coinbaseWallet` connector (ERC-4337 smart wallet + EOA)
- **Identity:** EAS (Ethereum Attestation Service) on Base, Basenames (ENS L2)
- **Onramp:** Coinbase OnchainKit `FundButton`
- **Backend:** Express 5, Node.js 24, TypeScript 5.9
- **Database:** PostgreSQL + Drizzle ORM (nonce replay cache, payment requests, contacts)
- **Chain:** Base Mainnet (chainId 8453)
- **Contracts:** Solidity 0.8.35, compiled + verified via Foundry
- **Payment protocol:** [x402](https://www.x402.org) (`@x402/express`, `@x402/evm`, `@x402/core`)
- **Builder attribution:** [ERC-8021](https://eips.ethereum.org/EIPS/eip-8021) appended to every relayed tx
- **Monorepo:** pnpm workspaces, OpenAPI-first codegen (Orval)

---

## Repository Layout

```
├── artifacts/
│   ├── api-server/        Express API + gasless relayer + x402 relay
│   │   └── src/routes/
│   │       ├── gasless.ts         EIP-3009 relay (POST /api/gasless/transfer)
│   │       ├── x402relay.ts       x402 payment-gated relay (POST /api/v2/relay)
│   │       ├── paymentRequests.ts shareable payment link CRUD
│   │       └── contacts.ts        address book CRUD
│   └── base-pay/          React dApp (wagmi + viem + OnchainKit)
│       └── src/
│           ├── lib/
│           │   ├── wagmi.ts                  wagmi config, connectors, addresses
│           │   ├── wagmi-experimental-shim.ts OnchainKit v1 compat shim
│           │   ├── useCoinbaseAttestation.ts  EAS attestation hook
│           │   ├── useUsdcAuthorization.ts    EIP-3009 signing hook
│           │   └── useBasename.ts            .base.eth resolution hook
│           ├── components/
│           │   ├── Layout.tsx     sidebar, wallet picker, smart wallet badge
│           │   └── WalletName.tsx address display + EAS badge
│           └── pages/
│               ├── Dashboard.tsx      balance, Buy USDC (OnchainKit)
│               ├── GaslessTransfer.tsx EIP-3009 + smart wallet detection
│               ├── BatchPay.tsx
│               ├── Escrow.tsx
│               └── ...
├── contracts/
│   ├── *.sol / *.json     Solidity source + full ABIs
│   ├── addresses.json     Machine-readable deployed addresses
│   ├── AUDIT.md           Slither static analysis report
│   ├── README.md          Integration guide
│   └── integration/
│       ├── viem.ts        viem v2 examples
│       ├── ethers.ts      ethers.js v6 examples
│       └── wagmi.tsx      wagmi + React hooks
├── lib/
│   ├── api-spec/          OpenAPI spec + generated hooks (Orval)
│   └── db/                Drizzle schema + migrations
└── scripts/               Utility scripts
```

---

## Integrating into your own dApp

```bash
# Copy the addresses
curl https://raw.githubusercontent.com/osr21/basepay-dapp/main/contracts/addresses.json

# Clone just the contracts directory
git clone --depth=1 --filter=blob:none --sparse https://github.com/osr21/basepay-dapp.git
cd basepay-dapp && git sparse-checkout set contracts
```

Then follow [`contracts/README.md`](./contracts/README.md) for viem, ethers.js, and wagmi examples.

---

## Known limitations

| Limitation | Detail |
|---|---|
| EIP-3009 requires EOA | Smart contract wallets (Coinbase Smart Wallet, Safe) cannot sign EIP-3009 messages usable by USDC's `ecrecover`. The dApp detects and warns. |
| x402 public facilitator is testnet-only | `https://x402.org/facilitator` supports Base Sepolia only. A CDP or self-hosted facilitator is required for Base Mainnet payment gating. |
| Relayer ETH balance | The gasless relayer must hold ETH on Base. The dApp shows a warning when the balance drops below 0.001 ETH. |

---

## License

MIT
