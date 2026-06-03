/**
 * push-github-docs.ts
 * Creates the basepay-dapp GitHub repo docs via the Replit GitHub connector.
 * Run: pnpm --filter @workspace/scripts run push-github-docs
 */
// @ts-ignore — connector SDK installed at workspace root
import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();
const OWNER = "osr21";
const REPO  = "basepay-dapp";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function putFile(path: string, content: string, message: string) {
  // Fetch existing SHA if the file already exists
  const getRes = await connectors.proxy("github", `/repos/${OWNER}/${REPO}/contents/${path}`, { method: "GET" });
  const getJson = await getRes.json() as { sha?: string };
  const sha = getJson.sha;

  const res = await connectors.proxy("github", `/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: b64(content), ...(sha ? { sha } : {}) }),
  });
  const json = await res.json() as { content?: { html_url: string }; message?: string };
  console.log(`[${res.status}] ${path} → ${json.content?.html_url ?? json.message}`);
}

/* ── README ─────────────────────────────────────────────────────────────── */
const README = `# BasePay

**BasePay** is a USDC stablecoin payments dApp built on [Base Mainnet](https://base.org).
Send, request, batch-pay, escrow, and automate recurring payments — all on-chain, non-custodial, with a 0.30% protocol fee.

Live app: https://base-pay.replit.app
Network: Base Mainnet (Chain ID 8453)
Token: USDC \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`

---

## Features

| Feature | Description |
|---|---|
| Send | Transfer USDC instantly to any address |
| Request | Shareable payment request links with QR codes |
| Batch Pay | Send to up to 200 recipients in one transaction |
| Escrow | Lock USDC for a payee with configurable timeout |
| Subscriptions | Recurring USDC pulls — daily, weekly, or monthly |
| Contacts | Save and reuse frequently used addresses |

---

## Smart Contracts

All contracts are deployed on Base Mainnet and source-verified on BaseScan.

| Contract | Address | BaseScan |
|---|---|---|
| BasePayRouter | \`0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8\` | [View](https://basescan.org/address/0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8#code) |
| BatchPay | \`0x82569caf7847040a03ad2c6545ade5af2bdcf47c\` | [View](https://basescan.org/address/0x82569caf7847040a03ad2c6545ade5af2bdcf47c#code) |
| Escrow | \`0x5b3241a47acfda41f15dfd7260339e2a88d52318\` | [View](https://basescan.org/address/0x5b3241a47acfda41f15dfd7260339e2a88d52318#code) |
| SubscriptionManager | \`0x546093b0476b4b7909cd84f3a0fef813c421d14a\` | [View](https://basescan.org/address/0x546093b0476b4b7909cd84f3a0fef813c421d14a#code) |

Protocol fee: **0.30%** on every transaction.

---

## Tech Stack

- Frontend: React 18 + Vite, Wagmi v2, viem, TailwindCSS
- Backend: Express 5, Drizzle ORM, PostgreSQL
- Contracts: Solidity 0.8.20
- Monorepo: pnpm workspaces, TypeScript 5.9, Zod v4, Orval codegen

---

## Docs

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — how to use the app
- [docs/CONTRACTS.md](docs/CONTRACTS.md) — contract ABI and interaction guide
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture

---

## License

MIT
`;

/* ── CONTRACTS ──────────────────────────────────────────────────────────── */
const CONTRACTS = `# Smart Contract Reference

All contracts: Solidity 0.8.20, optimizer enabled (200 runs), Base Mainnet (Chain ID 8453).

---

## BasePayRouter

Address: \`0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8\`
BaseScan: https://basescan.org/address/0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8#code

Routes single USDC transfers, deducting the 0.30% protocol fee.

### Key Function

\`\`\`solidity
function pay(address token, address to, uint256 amount, string calldata memo)
    external returns (uint256 net, uint256 fee);
\`\`\`

---

## BatchPay

Address: \`0x82569caf7847040a03ad2c6545ade5af2bdcf47c\`
BaseScan: https://basescan.org/address/0x82569caf7847040a03ad2c6545ade5af2bdcf47c#code

Sends USDC to multiple recipients in a single transaction (max 200).

### Key Function

\`\`\`solidity
function batchPay(
    address token,
    address[] calldata recipients,
    uint256[] calldata amounts,
    string  calldata  memo
) external returns (uint256 totalGross, uint256 totalFee, uint256 totalNet);
\`\`\`

### Usage
1. Approve BatchPay for sum(amounts) USDC
2. Call batchPay — 0.30% fee deducted per recipient

---

## Escrow

Address: \`0x5b3241a47acfda41f15dfd7260339e2a88d52318\`
BaseScan: https://basescan.org/address/0x5b3241a47acfda41f15dfd7260339e2a88d52318#code

Trustless USDC escrow with configurable timeout.

### Key Functions

\`\`\`solidity
function deposit(address token, address payee, uint256 amount, uint256 timeout, string calldata memo)
    external returns (uint256 id);

function claim(uint256 id) external;   // payee claims funds
function refund(uint256 id) external;  // depositor refunds after timeout
function quote(uint256 amount) external view returns (uint256 fee, uint256 net);
\`\`\`

### Lifecycle
deposit() -> active -> claim() [payee] or refund() [depositor after timeout]

---

## SubscriptionManager

Address: \`0x546093b0476b4b7909cd84f3a0fef813c421d14a\`
BaseScan: https://basescan.org/address/0x546093b0476b4b7909cd84f3a0fef813c421d14a#code

Recurring pull-payment subscriptions. Payer pre-authorises a per-period amount; payee triggers charges.

### Key Functions

\`\`\`solidity
function subscribe(address token, address payee, uint256 amount, uint256 interval, string calldata memo)
    external returns (uint256 id);

function charge(uint256 id) external;          // callable by anyone once per interval
function cancel(uint256 id) external;          // only payer or payee
function nextChargeAt(uint256 id) external view returns (uint256 timestamp);
function quote(uint256 amount) external view returns (uint256 fee, uint256 net);
\`\`\`

### Security
- Approve only the per-charge amount (not unlimited) to limit exposure
- Revoking USDC allowance immediately stops future charges
- interval: min 1 day, max 366 days
- feeBps capped at 1000 (10%) in contract; currently 30 (0.30%)

---

## Fee Formula

\`\`\`
fee = gross_amount * feeBps / 10_000
net = gross_amount - fee
\`\`\`

Fee collector: \`0xdb5019b8dfbccef8906c39b16a4870082eabbc4c\`
`;

/* ── ARCHITECTURE ────────────────────────────────────────────────────────── */
const ARCHITECTURE = `# Architecture

## System Diagram

\`\`\`
                    base-pay.replit.app
          ┌────────────────────────────────────┐
          │  React + Vite SPA                  │
          │  Wagmi v2 + viem                   │
          │  WalletConnect / Coinbase Wallet    │
          └──────────────┬─────────────────────┘
                         │ JSON-RPC (Base Mainnet)
                         ▼
          ┌────────────────────────────────────┐
          │           Base Mainnet             │
          │  BasePayRouter  BatchPay           │
          │  Escrow         SubscriptionMgr    │
          │  USDC: 0x833589fCD6eDb...          │
          └────────────────────────────────────┘
          ┌────────────────────────────────────┐
          │  Express 5 API (off-chain storage) │
          │  Drizzle ORM + PostgreSQL          │
          │  payment_requests, contacts tables │
          └────────────────────────────────────┘
\`\`\`

---

## Frontend (artifacts/base-pay)

React 18 + Vite SPA. All blockchain interactions use Wagmi v2 hooks.

### Pages and Routes

| Route | Page | Contract |
|---|---|---|
| / | Dashboard | — |
| /send | SendPage | BasePayRouter |
| /batch-pay | BatchPayPage | BatchPay |
| /request | RequestPage | — |
| /requests | RequestsPage | BasePayRouter |
| /escrow | EscrowPage | Escrow |
| /subscriptions | SubscriptionsPage | SubscriptionManager |
| /contacts | ContactsPage | — |
| /pay/:id | PayPage | BasePayRouter |

### Key Libraries
- wagmi v2 — contract reads/writes, wallet connection
- viem — ABI encoding, address validation
- @tanstack/react-query — on-chain data caching
- wouter — client-side routing
- TailwindCSS — dark-mode-first styling

---

## API Server (artifacts/api-server)

Express 5 with Drizzle ORM and PostgreSQL for off-chain data.

- API contract defined in OpenAPI spec (lib/api-spec)
- Orval generates React Query hooks and Zod schemas from the spec
- Validation with Zod v4 + drizzle-zod

---

## Monorepo Structure

\`\`\`
pnpm-workspace.yaml
tsconfig.base.json          # shared strict TS defaults
tsconfig.json               # solution file (libs only)
artifacts/
  base-pay/                 # @workspace/base-pay
  api-server/               # @workspace/api-server
lib/
  db/                       # @workspace/db (Drizzle schema)
  api-spec/                 # @workspace/api-spec (OpenAPI + codegen)
scripts/                    # @workspace/scripts (deploy/verify CLIs)
contracts/                  # Solidity source
\`\`\`

### Key Commands
\`\`\`bash
pnpm --filter @workspace/api-server run dev       # Start API
pnpm --filter @workspace/base-pay run dev         # Start frontend
pnpm run typecheck                                # Full TS check
pnpm --filter @workspace/api-spec run codegen     # Regen API hooks
pnpm --filter @workspace/db run push              # Push DB schema
pnpm --filter @workspace/scripts run verify-contracts  # Verify on BaseScan
\`\`\`

---

## Security Design

- Non-custodial: no user funds held by the protocol except Escrow by design
- Bounded approvals: UI approves exact per-charge amounts, never uint256.max
- Source-verified: all 4 contracts verified on BaseScan
- Fee cap: feeBps <= 1000 enforced in all contracts
- Access control: cancel/refund restricted to payer/payee; fee params restricted to owner
`;

/* ── GETTING STARTED ─────────────────────────────────────────────────────── */
const GETTING_STARTED = `# Getting Started

## Using the Live App

BasePay is live at **https://base-pay.replit.app**. You need:

1. A Web3 wallet (MetaMask, Coinbase Wallet, or WalletConnect)
2. ETH on Base Mainnet for gas (~$0.01 per tx)
3. USDC on Base Mainnet

### Get USDC on Base
- [Coinbase](https://coinbase.com) — buy USDC directly on Base
- [Base Bridge](https://bridge.base.org) — bridge ETH from Ethereum
- [Across Protocol](https://across.to) — fast cross-chain bridging

---

## Sending USDC

1. Connect wallet
2. Go to Send
3. Enter recipient, amount, memo (optional)
4. Approve USDC + confirm tx

---

## Batch Payments

1. Go to Batch Pay
2. Add recipients and amounts (up to 200)
3. Approve the total USDC
4. Confirm — all transfers in one tx

---

## Escrow

1. Go to Escrow
2. Enter payee, amount, timeout (1/7/30/90 days)
3. Approve USDC -> Deposit
4. Payee calls Claim, or you Refund after timeout

---

## Subscriptions

1. Go to Subscribe
2. Enter payee, amount per period, interval (daily/weekly/monthly)
3. Approve one period's USDC -> Subscribe
4. Payee (or anyone) calls charge(id) once per interval

To stop: revoke USDC allowance in your wallet or call cancel(id) on BaseScan.

---

## Payment Requests

1. Go to Request
2. Set amount + memo
3. Share the generated link or QR code

---

## Running Locally

\`\`\`bash
git clone https://github.com/osr21/basepay-dapp
cd basepay-dapp
pnpm install

# Environment variables needed:
# DATABASE_URL, SESSION_SECRET
# VITE_ROUTER_ADDRESS, VITE_BATCH_PAY_ADDRESS
# VITE_ESCROW_ADDRESS, VITE_SUBSCRIPTION_MANAGER_ADDRESS

pnpm --filter @workspace/api-server run dev   # API on :5000
pnpm --filter @workspace/base-pay run dev     # Frontend
\`\`\`

---

## Deploying Your Own Contracts

\`\`\`bash
# Requires DEPLOYER_PRIVATE_KEY env var + ETH on Base
pnpm --filter @workspace/scripts run deploy-router
pnpm --filter @workspace/scripts run deploy-batch-pay
pnpm --filter @workspace/scripts run deploy-escrow
pnpm --filter @workspace/scripts run deploy-subscription-manager

# Requires BASESCAN_API_KEY env var
pnpm --filter @workspace/scripts run verify-contracts
\`\`\`
`;

/* ── Push files sequentially to avoid SHA race conditions ────────────────── */
const FILES: Array<[string, string, string]> = [
  ["README.md",                README,          "docs: add README"],
  ["docs/CONTRACTS.md",        CONTRACTS,       "docs: contract reference"],
  ["docs/ARCHITECTURE.md",     ARCHITECTURE,    "docs: architecture guide"],
  ["docs/GETTING_STARTED.md",  GETTING_STARTED, "docs: getting started guide"],
];

for (const [path, content, message] of FILES) {
  await putFile(path, content, message);
}

console.log("\nDone! https://github.com/osr21/basepay-dapp");
