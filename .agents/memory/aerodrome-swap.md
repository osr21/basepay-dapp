---
name: Aerodrome Swap Architecture
description: Gasless USDC↔EURC swap via Aerodrome Finance on Base — why Uniswap V3 was dropped and how the 4-tx relayer flow works
---

## Key finding: Uniswap V3 unusable for USDC/EURC on Base

- Uniswap V3 QuoterV2 `0x3D4e44EB1374240cE5F1B136CF68a4F7f823AE3A` has **zero bytecode** on Base mainnet (wrong address).
- All four Uniswap V3 USDC/EURC pools (fee tiers 100/500/3000/10000) exist at the factory but have `liquidity: 0n` — no active LP positions.

## Aerodrome Finance contracts on Base (confirmed live)

- PoolFactory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` (40 hex chars — note trailing 'a')
- Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- USDC/EURC stable pool: `0xeF0d374FE41fC6dA7f8ED7c56C10A8f2A4f75313`
- USDC/EURC volatile pool: `0xFDF5139b38525627B47538536042A7c8d2686BD9`
- Quote via `getAmountsOut(uint256, tuple[])` — see swap.ts for JSON ABI (human-readable fails on tuple array)
- Volatile pool often gives better rate for USDC/EURC than stable pool — always try both and pick best

## Relayer EIP-7702 constraint

- The DEPLOYER_PRIVATE_KEY relayer is a delegated (EIP-7702) account on Base mainnet
- Sending transactions at startup can fail with "in-flight transaction limit reached for delegated accounts"
- **Pattern**: skip module-level pre-approvals; check allowance inline during execute and approve only when needed

## Gasless swap 4-tx flow (swap.ts)

1. TX1: `token.permit(user, relayer, amountIn, deadline, v, r, s)` — relayer submits the user's off-chain EIP-2612 sig
2. TX2: `token.transferFrom(user, relayer, amountIn)` — relayer pulls tokens
3. TX3 (conditional): `token.approve(aerodromeRouter, maxUint256)` — only if relayer's allowance is insufficient
4. TX4: `aerodromeRouter.swapExactTokensForTokens(...)` — output goes to relayer
5. TX5: `outputToken.transfer(user, amountOut - 0.30% fee)` — user receives net amount

**Why permit spender = relayer (not router):** Aerodrome router's `swapExactTokensForTokens` always pulls from `msg.sender`. The router has no `selfPermit`. User must permit the relayer, which then transfers to itself and swaps.

## EIP-7702 smart wallet incompatibility with EIP-2612 permit

User address `0xB14436...` has 23-byte EIP-7702 delegation bytecode (Coinbase Smart Wallet).
When a passkey-based smart wallet signs `eth_signTypedData`, it produces a WebAuthn signature
that is NOT valid ECDSA. USDC's `permit()` uses `SignatureChecker.isValidSignatureNow()`, which
tries `ecrecover` first (fails) then `isValidSignature(owner, digest, abi.encodePacked(r,s,v))`.
The packed 65-byte truncation isn't the full WebAuthn sig, so the ERC-1271 check fails too.
The permit TX **reverts on-chain** but `viem.waitForTransactionReceipt` does NOT throw on reverts
— it just returns the receipt. You must explicitly check `receipt.status === "success"`.

**Fix applied:**
- Backend: check `receipt.status` after every `waitForTransactionReceipt`; on revert return 400 with clear message about smart wallet incompatibility
- Backend: post-permit allowance readback as belt-and-suspenders
- Frontend: `eth_getCode` bytecode check (same pattern as GaslessTransfer.tsx); if bytecode ≠ "0x", show warning + disable swap button

**Why viem doesn't throw on revert:** `waitForTransactionReceipt` resolves when the TX is included
in a block regardless of its execution outcome. You must check `receipt.status` yourself.

## Token address comparison gotcha

Always define lowercase constants for comparison:
```typescript
const USDC_LC = USDC.toLowerCase();
// then: if (input.toLowerCase() === USDC_LC) { ... }
```
Never compare `input.toLowerCase() === USDC` when USDC is a checksummed address — will always fail.
