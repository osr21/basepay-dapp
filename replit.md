# BasePay — USDC Payments on Base

Open-source USDC payment infrastructure on Base Mainnet. React dApp + Express API + four verified Solidity contracts covering sends, gasless transfers, batch payments, escrow, and subscriptions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080 internally, proxied to `/api`)
- `pnpm --filter @workspace/base-pay run dev` — run the React frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `DEPLOYER_PRIVATE_KEY`, `SESSION_SECRET`, `FEE_COLLECTOR_ADDRESS` (optional — enables x402 gate), `BASESCAN_API_KEY`, `VITE_CDP_API_KEY` (OnchainKit)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19, Vite, wagmi v3, viem v2, TailwindCSS, Wouter, OnchainKit
- API: Express 5, Pino logging
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec in `lib/api-spec/`)
- Build: esbuild (CJS bundle for API server)
- Payment protocol: x402 (`@x402/express`, `@x402/evm`, `@x402/core`)

## Where things live

- DB schema: `lib/db/src/schema.ts`
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- Generated React hooks: `lib/api-spec/src/generated/`
- wagmi config + addresses: `artifacts/base-pay/src/lib/wagmi.ts`
- EAS attestation hook: `artifacts/base-pay/src/lib/useCoinbaseAttestation.ts`
- EIP-3009 signing hook: `artifacts/base-pay/src/lib/useUsdcAuthorization.ts`
- Gasless relay route: `artifacts/api-server/src/routes/gasless.ts`
- x402 relay route: `artifacts/api-server/src/routes/x402relay.ts`
- Contract ABIs + addresses: `contracts/*.json`, `contracts/addresses.json`
- Theme: TailwindCSS config in `artifacts/base-pay/tailwind.config.ts`

## Architecture decisions

- **EIP-3009 for gasless, EIP-2612 for contracts.** EIP-3009 authorises a specific transfer (used by the relayer); EIP-2612 permit authorises an allowance (used by Router/Escrow/Batch for one-tx flows). Both avoid a separate approve tx.
- **Smart wallet detection via `eth_getCode`.** EIP-3009's `ecrecover` check only works with EOA signatures. The dApp calls `getBytecode` on the connected address; if bytecode exists it's a smart contract wallet and the gasless page shows a warning + disables send.
- **x402Gate wrapper pattern.** The public x402 facilitator only supports Base Sepolia. Rather than crash with a 500, a response interceptor detects "Route Configuration Errors" from the middleware and converts them to a 503 with a clear message, caching the result in-process.
- **OnchainKit wagmi compat shim.** OnchainKit 1.x imports from `wagmi/experimental` which was removed in wagmi v3. A stub file (`wagmi-experimental-shim.ts`) re-exports the needed symbols and is aliased via Vite config.
- **OpenAPI-first.** All API shapes flow from `lib/api-spec/openapi.yaml` through Orval codegen into typed React Query hooks and Zod schemas. Never hand-write fetch calls for backend routes.

## Product

BasePay is a full-stack USDC payments dApp on Base Mainnet. Users can:
- **Send USDC** to any address or Basename with EIP-2612 permit (one signature, one tx)
- **Transfer gasless** — sign an EIP-3009 message, relayer pays ETH gas
- **Batch pay** — up to 200 recipients in one tx
- **Escrow** — time-lock USDC, release or refund
- **Subscribe** — set up recurring on-chain charges
- **Request payments** via shareable links
- **Buy USDC** via Coinbase onramp (OnchainKit `FundButton`)
- See **EAS verification badges** on Coinbase-verified wallets
- Connect with **Coinbase Smart Wallet** (ERC-4337) or any injected EOA

## User preferences

- Never use `console.log` in server code — use `req.log` in route handlers and singleton `logger` elsewhere
- Keep OpenAPI spec as source of truth; run codegen after any route shape change

## Gotchas

- **Do not run `pnpm dev` at repo root** — no root dev script. Run per-package via workflow or `pnpm --filter @workspace/<name> run dev`.
- **x402 public facilitator is testnet-only.** `https://x402.org/facilitator` supports `eip155:84532` (Base Sepolia). For mainnet payment gating, set up a CDP or self-hosted facilitator.
- **EIP-3009 requires EOA signatures.** Smart contract wallets (Coinbase Smart Wallet with Passkeys, Safe) return incompatible signature formats. Always check `eth_getCode` before attempting gasless.
- **Always run `typecheck` before declaring a feature done.** Editor LSP and CLI can disagree on cross-package types; the root `pnpm run typecheck` is authoritative.
- **Relayer must hold ETH on Base.** Derived from `DEPLOYER_PRIVATE_KEY`. Top up when balance drops below 0.001 ETH.
- **OnchainKit shim must stay in sync.** If wagmi internals change, update `wagmi-experimental-shim.ts`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Contract integration examples: `contracts/integration/viem.ts`, `contracts/integration/wagmi.tsx`
- Full feature docs: `README.md`
