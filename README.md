# BasePay — USDC Payments on Base

  Open-source USDC payment infrastructure on **Base Mainnet**. Four verified smart contracts, a gasless transfer relayer, and a full React dApp — all permissionless and free to fork or integrate.

  **Live:** [basepay.replit.app](https://basepay.replit.app) · **Chain:** Base Mainnet (chainId 8453) · **Tokens:** USDC · EURC

  ---

  ## Features

  | Feature | Description | Route |
  |---|---|---|
  | **Send** | USDC transfer via EIP-2612 permit (one signature, one tx) | `/send` |
  | **Gasless Transfer** | Sign off-chain (EIP-3009); relayer pays ETH gas — USDC and EURC | `/gasless` |
  | **⚡ Flashblocks** | Pre-confirmation in ~200ms — shows receipt before the 2s block boundary | `/gasless` |
  | **Gasless Swap** | Swap USDC ↔ EURC via Aerodrome Finance — one signature, zero ETH | `/gasless-swap` |
  | **Batch Pay** | Up to 200 recipients in a single transaction | `/batch-pay` |
  | **Escrow** | Time-locked USDC with release or refund | `/escrow` |
  | **Subscriptions** | On-chain recurring charges at fixed intervals | `/subscriptions` |
  | **Payment Requests** | Shareable links that pre-fill recipient and amount | `/request` |
  | **B20 Tokens** | Look up, transfer, and deploy Base's native B20 token standard | `/b20` |
  | **Multi-Currency Stablecoins** | Track B20 stablecoins for BRL, MXN, NGN, INR, GBP, JPY, PHP | `/b20` |
  | **AI Agent Payments** | Autonomous USDC payments via EIP-3009 + x402 micropayment relay | `/agent` |
  | **Cross-Chain Transfer** | Bridge USDC to Ethereum, Optimism, Arbitrum, Polygon via Circle CCTP v1 | `/cctp` |
  | **Basenames** | Forward-resolves `.base.eth` names throughout the dApp | global |
  | **EAS Verification** | Coinbase attestation badge on verified accounts | global |
  | **Developer API** | `bpk_` API keys for programmatic relay access | `/developer` |

  ---

  ## Recent Additions (July 2026)

  ### ⚡ Flashblocks Pre-Confirmation

  After a gasless transfer is relayed, BasePay polls `eth_getTransactionReceipt` every 200 ms using Base's Flashblocks-aware RPC. The first receipt returned — typically within ~200 ms — means the transaction is **ordering-committed** before the 2-second block boundary. A real-time "⚡ Pre-confirmed in Xms" badge is shown to the user.

  → [docs/FLASHBLOCKS.md](docs/FLASHBLOCKS.md) · [Route: /gasless](https://basepay.replit.app/gasless)

  ### 🏭 B20 Token Standard

  Base's Beryl upgrade (July 8, 2026) introduced B20 — a Rust precompile that replaces EVM bytecode for token deployment. BasePay's `/b20` page lets you look up any B20 token, transfer with an on-chain memo, and deploy your own B20 stablecoin in one factory call.

  ```typescript
  // Deploy a B20 stablecoin — no Solidity, no audit, no bytecode
  await walletClient.writeContract({
    address: "0xB20f000000000000000000000000000000000000", // B20 factory precompile
    abi: B20_FACTORY_ABI,
    functionName: "createB20",
    args: [
      1n,          // variant: 0 = ASSET, 1 = STABLECOIN
      salt,        // keccak256(toBytes("your-project-name"))
      params,      // ABI-encoded (name, symbol, admin, currencyCode)
      [],          // optional initCalls (mint, configure)
    ],
  });
  ```

  → [docs/B20_TOKENS.md](docs/B20_TOKENS.md) · [docs/MULTICURRENCY.md](docs/MULTICURRENCY.md) · [Route: /b20](https://basepay.replit.app/b20)

  ### 🤖 AI Agent Payments (x402)

  AI agents can send USDC programmatically — no ETH required, no human approval. The agent signs an EIP-3009 `TransferWithAuthorization` message off-chain, then POSTs to BasePay's x402-gated relay endpoint. Authentication is via a `bpk_` API key or a $0.001 USDC x402 micropayment.

  ```bash
  # One call — agent signs, relay submits, USDC moves on-chain
  curl -X POST https://basepay.replit.app/api/v2/relay \
    -H "X-API-Key: bpk_your_key" \
    -H "Content-Type: application/json" \
    -d '{"token":"0x833589...","from":"0xAGENT","to":"0xRECIP","value":"1000000",...}'
  ```

  → [docs/AI_AGENTS.md](docs/AI_AGENTS.md) · [Route: /agent](https://basepay.replit.app/agent)

  ---

  ## Smart Contracts (Base Mainnet)

  | Contract | Address | BaseScan |
  |---|---|---|
  | BasePayRouter | `0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8` | [View](https://basescan.org/address/0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8#code) |
  | BatchPay | `0x82569caf7847040a03ad2c6545ade5af2bdcf47c` | [View](https://basescan.org/address/0x82569caf7847040a03ad2c6545ade5af2bdcf47c#code) |
  | Escrow | `0x5b3241a47acfda41f15dfd7260339e2a88d52318` | [View](https://basescan.org/address/0x5b3241a47acfda41f15dfd7260339e2a88d52318#code) |
  | SubscriptionManager | `0x546093b0476b4b7909cd84f3a0fef813c421d14a` | [View](https://basescan.org/address/0x546093b0476b4b7909cd84f3a0fef813c421d14a#code) |

  Protocol fee: **0.30%** on every transaction.

  ---

  ## Tech Stack

  - **Frontend:** React 19, Vite, wagmi v3, viem v2, TailwindCSS, Wouter, OnchainKit
  - **API:** Express 5, Pino logging, Drizzle ORM, PostgreSQL
  - **Monorepo:** pnpm workspaces, TypeScript 5.9, Zod v4
  - **API codegen:** Orval (OpenAPI → React Query hooks + Zod schemas)
  - **Payment protocol:** x402 (`@x402/express`, `@x402/evm`, `@x402/core`)
  - **Contracts:** Solidity 0.8.20, source-verified on BaseScan

  ---

  ## Documentation

  | File | Description |
  |---|---|
  | [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | How to use the live app and run locally |
  | [docs/CONTRACTS.md](docs/CONTRACTS.md) | Smart contract ABIs and interaction guide |
  | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and monorepo structure |
  | [docs/FLASHBLOCKS.md](docs/FLASHBLOCKS.md) | Flashblocks pre-confirmation implementation |
  | [docs/B20_TOKENS.md](docs/B20_TOKENS.md) | B20 token standard integration |
  | [docs/MULTICURRENCY.md](docs/MULTICURRENCY.md) | Multi-currency B20 stablecoin tracking |
  | [docs/AI_AGENTS.md](docs/AI_AGENTS.md) | AI agent payments via EIP-3009 + x402 |
  | [docs/EURC_GASLESS.md](docs/EURC_GASLESS.md) | EURC gasless transfer details |
  | [docs/GASLESS_SWAP.md](docs/GASLESS_SWAP.md) | Aerodrome gasless swap implementation |
  | [docs/GASLESS_CCTP.md](docs/GASLESS_CCTP.md) | Cross-chain USDC transfer (Circle CCTP) |
  | [contracts/README.md](contracts/README.md) | Contract deployment and verification |

  ---

  ## Running Locally

  ```bash
  git clone https://github.com/osr21/basepay-dapp
  cd basepay-dapp
  pnpm install

  # Required env vars: DATABASE_URL, SESSION_SECRET, DEPLOYER_PRIVATE_KEY
  # Optional: VITE_ONCHAINKIT_API_KEY, CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY

  pnpm --filter @workspace/api-server run dev   # API server on :8080
  pnpm --filter @workspace/base-pay run dev     # React frontend
  pnpm run typecheck                             # Full TypeScript check
  pnpm --filter @workspace/api-spec run codegen # Regen API hooks from OpenAPI spec
  ```

  ---

  ## Key Architecture Decisions

  - **EIP-3009 for gasless, EIP-2612 for contracts.** EIP-3009 authorises a specific transfer (used by the relayer); EIP-2612 permit authorises an allowance (used by Router/Escrow/Batch for one-tx flows).
  - **Flashblocks via polling.** `eth_getTransactionReceipt` at 200ms intervals works with Base's public RPC — no WebSocket node required.
  - **OpenAPI-first.** All API shapes flow from `lib/api-spec/openapi.yaml` through Orval codegen into typed React Query hooks and Zod schemas.
  - **x402 CDP facilitator.** Base Mainnet x402 gating uses the CDP facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`) — the public facilitator only supports testnet.
  - **B20 factory precompile.** B20 tokens are created via a single `createB20()` call to the precompile at `0xB20f000000000000000000000000000000000000` — no bytecode deployment.

  ---

  ## License

  MIT
  