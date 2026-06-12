---
name: CCTP Cross-Chain Transfer
description: Circle CCTP v1 integration on Base — key addresses, flow, and TypeScript gotchas
---

## Key Addresses (Base Mainnet)
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- TokenMessenger: `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962`
- MessageTransmitter: `0xAD09780d193884d503182aD4588450C416D6F9D4`
- MessageSent topic: `0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036`

## Destination Domains
- Ethereum (1): domain 0, MessageTransmitter `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81`
- Optimism (10): domain 2, MessageTransmitter `0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8`
- Arbitrum (42161): domain 3, MessageTransmitter `0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca`
- Polygon (137): domain 7, MessageTransmitter `0xF3be9355363857F3e001be68856A2f96b4C39Ba9`

## Transfer Flow
1. `approve(TokenMessenger, amount)` on USDC (Base)
2. `depositForBurn(amount, destDomain, mintRecipient_bytes32, USDC_BASE)` on TokenMessenger
3. Parse `MessageSent` log from MessageTransmitter in burn receipt: `decodeAbiParameters([{type:"bytes"}], log.data)` → messageBytes; `keccak256(messageBytes)` → messageHash
4. Poll `/api/cctp/attestation/:messageHash` (Circle API proxy) until `status === "complete"`
5. `switchChain` to destination
6. `receiveMessage(messageBytes, attestation)` on destination MessageTransmitter

## TypeScript Gotcha
`dest.chain.id` from viem's `Chain` type is `number`, but wagmi actions (waitForTransactionReceipt, switchChainAsync) expect `config['chains'][number]['id']` (specific literal union). Cast as: `dest.chain.id as (typeof config)['chains'][number]['id']`.

**Why:** wagmi v3 uses const-generic config pattern to derive allowed chain IDs; viem's Chain is a generic type with `id: number`.

## WrongNetworkBanner Suppression
The `WrongNetworkBanner` in Layout.tsx checks `location === "/cross-chain"` and suppresses itself — switching away from Base is intentional during the receive step.
