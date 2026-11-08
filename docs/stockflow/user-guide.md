# StockFlow user guide

[Documentation hub](README.md)

## Wallet, network and funding

- Mainnet trading uses **Base Mainnet, chain ID 8453**, not Base Sepolia.
- Trading supports EOAs and EIP-7702 wallets. Contract-wallet administration can
  authenticate with supported signatures, but bundled contract-wallet trades are
  not supported by the current receipt-verification flow.
- Use native Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Hold ETH on Base for approval/reset and swap network fees. Mainnet stock
  trading is not the separate BasePay gasless-transfer service.
- Funding a wallet does not grant eligibility or trading access.

## Sign in and obtain access

Open [StockFlow](https://base-pay.replit.app/stockflow), choose **Base Mainnet**,
connect the intended wallet and sign the displayed login challenge. Signing in
does not approve a token or move funds. The operator must independently review
and approve the wallet. A missing, expired or revoked grant blocks new quotes
and preparation. Changing the connected wallet does not transfer its access.

## Buy stock tokens with USDC

1. Select the actual stock token and **Buy**. Enter a human-readable USDC amount,
   for example `0.10`; do not enter the six-decimal raw integer.
2. Request a live quote. Check the stock, recipient, amount, minimum output,
   slippage, impact, router/pool and expiry. Reference NAV is not an executable
   price, and a listed asset may have no supported pool.
3. Review network fees and balances. Missing fee components are unavailable,
   not free. Some estimates only become possible after an allowance confirms.
4. If needed, confirm an exact-amount token approval. An insufficient nonzero
   allowance may first require a reset to zero. Approval alone does not buy.
5. Review the real-money trade separately and confirm the swap in the wallet.
   If the quote expires, request another; do not reuse expired calldata.
6. Retain the displayed transaction hash and inspect its explorer link.

The current pilot adds no BasePay service fee. Pool fees are reflected in the
quoted output; ETH network fees are separate. Estimates are not guaranteed
maximums and can differ from receipt-paid costs.

## Sell stock tokens

Choose **Sell**, enter the stock-token quantity and review the USDC output.
The same wallet, approval, expiry, fee and minimum-output safeguards apply.
Sales are capped at 100 USDC of quoted proceeds. A balance or NAV does not
guarantee an available exit pool or issuer redemption rights.

## Transaction states and recovery

- A submitted hash is not proof of execution.
- A successful mined receipt proves inclusion; StockFlow's terminal history
  states wait for a canonical receipt included by Base's safe block.
- Wallet speed-ups are verified against the original sender, nonce and exact
  trade. Cancellations and changed transactions are not successful stock swaps.
- On recording failure or reload, reconnect the original wallet and sign in.
  Recovery reconciles the existing transaction; it does not resend it.
- Preserve original and replacement hashes if the RPC cannot prove their
  relationship. Do not place another order merely because history is delayed.

Reviewed estimates and actual receipt-paid fees are different values. History
swap fees do not include separate token approval/reset transactions.
Allowance revocation remains available after trading access expires.

## Planning, income and sandbox

Local planning limits do not constrain a manually signed Mainnet swap. Saving a
policy for income creates a separate server-side planning snapshot; later local
edits do not change it automatically. **Mark reviewed — no trade** and
**Dismiss proposal** do not authorize spending.

EURC receipts are retained in EURC, but proposals remain blocked without a verified
exchange rate. There is no assumed EURC/USD parity.

The Sepolia sandbox uses virtual demoUSD and demo shares, not redeemable assets.
Deploy it only on chain 84532 with testnet ETH. See the
[planner/income/sandbox reference](../stockflow.md).
