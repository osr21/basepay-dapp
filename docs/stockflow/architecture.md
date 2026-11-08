# StockFlow architecture and smart contracts

[Documentation hub](README.md) · [Detailed pilot](../stockflow-mainnet-pilot.md)

## System overview

```text
Connected wallet ── login signature ──► StockFlow API / secure session
      │                                      │
      │                              PostgreSQL grants, quotes,
      │                              audit and trade history
      │                                      │
      ├── exact token approval ───────────────► USDC / stock-token contract
      └── individually confirmed swap ────────► Aerodrome router
                                             │
                                      direct USDC pool
                                             │
                                      output to same wallet

Incoming Transfer receipts ──► verified ledger ──► allocation proposals
                                                     │
                                           manual review only
                                           (no automatic swap)
```

The API discovers and quotes pools, validates pilot access, simulates prepared
trades and verifies outcomes. Normal users sign with their own wallets.
The server does not custody stock-trading deposits or expose a general-purpose
server-signed trading endpoint.

## Mainnet dependencies

All addresses below are on **Base Mainnet (8453)**.

| Contract | Address |
| --- | --- |
| Aerodrome SwapRouter | [`0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F`](https://basescan.org/address/0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F) |
| Aerodrome factory | [`0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`](https://basescan.org/address/0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef) |
| Aerodrome quoter | [`0x514c8B5f54112481E28028F1166Bd78501089259`](https://basescan.org/address/0x514c8B5f54112481E28028F1166Bd78501089259) |
| Native USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| NVDAc used in the documented smoke test | [`0xb20000000000000000000078ee7ce2fE4908108C`](https://basescan.org/address/0xb20000000000000000000078ee7ce2fE4908108C) |

Stock tokens are existing issuer/protocol assets, not newly issued StockFlow
tokens. The official catalogue supplies current asset metadata; the NVDAc
example is not an instruction to trade without fresh eligibility/liquidity checks.
The router/quoter factory identities are checked before quotes.

**No additional StockFlow contract is required for the current Mainnet pilot.**
The separately existing AgentSpendPolicyV1 transfer policy is not a swap-output
policy and is not the executor used by this trading flow. A future vault or
onchain strategy executor would be a separate design and security-review effort.

## Data and execution boundaries

- **Catalogue/positions:** official Coinbase catalogue, onchain decimals/balances,
  B20 share-equivalent reads, explicit unavailable/stale data. NAV is not a quote.
- **Local planner:** browser-local rules and preview history; disconnected data
  stays separate from connected-wallet data.
- **Income ledger:** wallet-proven persisted policy snapshots, canonical transfer
  receipts, idempotent proposals and signed manual review decisions.
- **Pilot:** expiring reviewed grants and audit history, wallet-owned quotes,
  verified trade records and replacement tracking.
- **Recovery:** a wallet-scoped browser journal plus server reconciliation;
  failure to save a hash does not authorize another transaction.

Mainnet quote discovery uses a pinned block, supported pool tick spacings and
integer arithmetic. Router calldata fixes token pair, input amount, minimum
output, recipient and deadline. Receipt validation checks the sender, target and
exact economic calldata, permitting only canonical ERC-8021 attribution metadata.

## Fees and confirmation

Network fees have three components: L2 execution, L1 data and any operator fee.
Estimates and receipt-paid costs are stored/displayed separately. Unknown
components do not become zero. Historical operator accounting must use the
appropriate receipt-block Isthmus/Jovian rules, not today's configuration.

Receipt inclusion, Base safe-block confirmation and ultimate L1 finality are
different concepts. StockFlow does not label an unverified replacement or a
mined-but-not-safe outcome as a finalized stock trade.

## Sepolia sandbox

`StockFlowSandbox` is owner-deployed per user on **Base Sepolia (84532)**.
Its constructor rejects other networks, including Mainnet. It tracks virtual
demoUSD and shares, owner-initiated limits, expiry and revocation. There is no
USDC deposit, withdrawal or redemption path and no universal shared deployment
address. It is not used by Mainnet swaps.
