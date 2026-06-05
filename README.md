# BasePay — USDC Payments on Base

Open-source USDC payment infrastructure on **Base Mainnet**. Four verified smart contracts, a gasless transfer relayer, and a full React dApp — all permissionless and free to fork or integrate.

**Live:** [basepay.replit.app](https://basepay.replit.app) &nbsp;·&nbsp; **Chain:** Base Mainnet (chainId 8453) &nbsp;·&nbsp; **Token:** USDC

---

## Features

| Feature | Description |
|---|---|
| **Send** | USDC transfer via approve→transfer or EIP-2612 permit (one tx) |
| **Gasless Transfer** | User signs off-chain; relayer pays the ETH gas — user pays zero |
| **Batch Pay** | Up to 200 recipients in a single transaction |
| **Escrow** | Time-locked USDC with release / refund |
| **Subscriptions** | On-chain recurring charges at fixed intervals |
| **Payment Requests** | Shareable links that pre-fill recipient and amount |

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

1. **User signs** an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` typed message — this is an off-chain signature, identical to an EIP-712 sign, requiring no ETH and no wallet transaction.
2. **Client posts** the signature + parameters to `POST /api/gasless/transfer`.
3. **API validates** the request: timing window, USDC balance, and replay protection (in-memory nonce guard → DB check → on-chain `authorizationState`).
4. **Relayer submits** `USDC.transferWithAuthorization(from, to, value, ...)` — paying the Base gas fee from its own ETH balance.
5. **USDC moves** directly from the user's wallet to the recipient. The relayer never holds the funds.

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

- **Frontend:** React 19, Vite, wagmi v3, viem v2, TailwindCSS
- **Backend:** Express 5, Node.js 24, TypeScript 5.9
- **Database:** PostgreSQL + Drizzle ORM (nonce replay cache, payment requests)
- **Chain:** Base Mainnet (chainId 8453)
- **Contracts:** Solidity 0.8.35, compiled + verified via Foundry
- **Builder attribution:** [ERC-8021](https://eips.ethereum.org/EIPS/eip-8021) appended to every relayed tx
- **Monorepo:** pnpm workspaces

---

## Repository Layout

```
├── artifacts/
│   ├── api-server/        Express API + gasless relayer
│   └── base-pay/          React dApp (wagmi + viem)
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
│   ├── api-spec/          OpenAPI spec + generated hooks
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

## License

MIT
