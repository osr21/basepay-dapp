---
name: Gasless Transfer Architecture
description: How gasless USDC transfers work in BasePay — EIP-3009, relayer design, key decisions
---

## Setup
- USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) supports EIP-3009 `transferWithAuthorization`
- Domain: name="USD Coin", version="2", chainId=8453
- Relayer uses `DEPLOYER_PRIVATE_KEY` (already in Replit secrets) to sign/submit txs
- Relay fee: currently free (Base gas ~$0.001/tx)

## Flow
1. Frontend: `useUsdcAuthorization` hook → `signTypedData` for `TransferWithAuthorization`
2. POST to `/api/gasless/transfer` with (from, to, value, validAfter, validBefore, nonce, v, r, s)
3. API server: validates input, checks nonce unused (DB + on-chain `authorizationState`), calls `USDC.transferWithAuthorization`
4. Records nonce in `gasless_nonces` table to prevent replay

## Key decisions
**Why self-hosted relayer over Coinbase Paymaster/ERC-4337:** Fits existing Express API; no smart wallet requirement for users; simpler integration; Base gas costs are negligible.

**Why EIP-3009 (not EIP-2612):** EIP-3009 moves USDC directly with one signature. EIP-2612 (permit) only authorizes a spender — still needs a second tx for the actual transfer.

**Nonce format:** Random bytes32 (not sequential uint256 like EIP-2612). Generated client-side via `crypto.getRandomValues`.

## Files
- `artifacts/base-pay/src/lib/useUsdcAuthorization.ts` — signing hook
- `artifacts/base-pay/src/pages/GaslessTransfer.tsx` — page
- `artifacts/api-server/src/routes/gasless.ts` — relay route
- `lib/db/src/schema/gaslessNonces.ts` — nonce tracking table
