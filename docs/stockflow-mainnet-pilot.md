# StockFlow Base Mainnet pilot

## What is live-capable

The StockFlow **Base Mainnet** mode implements manual, non-custodial USDC buys
and stock-token sales through Aerodrome's deployed Slipstream router. It does
not deploy a new stock token, use the sandbox contract, or sign with a server
key. Only direct USDC pools in the current approved factory are supported.
No NAV/reference value is used as an execution quote.

Mainnet transactions need a connected wallet, its confirmation for every
approval/trade, and Base ETH for gas. Approval does not execute a trade.
Automated implementation checks use unfunded fixtures and read-only chain calls.
A separate, explicitly authorized [Mainnet smoke trade on 8 November 2026](stockflow/mainnet-test-2026-11-08.md)
spent 0.10 USDC. That one-off operator test used the configured signer with
explicit permission; it did not add server-signed trading to the normal product.
Trading currently supports EOA and EIP-7702 wallets. Contract wallets can
authenticate for administration, but cannot request pilot trade quotes: bundled
account-abstraction transactions need a different receipt-verification flow.

## Operator setup and access

- `STOCKFLOW_PILOT_ADMIN_WALLETS`: comma-separated public administrator addresses.
- `STOCKFLOW_PILOT_ENABLED`: must be exactly `true`; missing/invalid administrator
  configuration or any other enabled value denies trading.
- Existing `SESSION_SECRET` signs one-hour, HttpOnly, Secure, SameSite=Strict
  wallet sessions scoped to `/api/stockflow`. Single-use sign-in challenges are
  persisted in PostgreSQL and atomically consumed. Signatures also support
  ERC-1271/6492 wallets.
- The configured administrator signs in on **StockFlow → Base Mainnet** and
  reviews each participant before granting access. Administrators are not
  automatically approved to trade. Approvals expire after at most 30 days;
  edits/revocations are recorded with their previous state in a DB audit trail.
- Both quote and preparation requests recheck current approval, expiry,
  jurisdiction policy, global switch and signed-in wallet. Old transactions
  can still be reconciled after access is revoked.

Europe and Asia are the intended regions, **not an approved-country or
investor list**. The operator must review investor eligibility, issuer holder/
transfer restrictions, sanctions and local rules. Region validation and a
review checkbox are not automated KYC, IP geofencing, a licence or legal
clearance. Public users cannot self-approve or change their country to gain
access. No identity documents are collected by this interface.

Use an actual two-letter country code, not a region. The United Kingdom is
`GB`; current input validation also normalizes `UK` to `GB`. Country errors and
missing operator-review confirmation are reported separately.
Approvals belong to the database of the app where they were saved: a published
approval is not automatically a preview approval. Check the correct environment
before asking an operator to repeat the review. See the
[operator guide](stockflow/operator-guide.md).

## Transaction controls

1. Read stocks from the official Coinbase catalogue; check token decimals onchain.
2. Verify mainnet and the fixed router/quoter factory identities.
3. Discover direct USDC pools at a pinned block and obtain real `eth_call` quotes.
4. Reject pools above 5% fee-inclusive price impact relative to their pool spot.
   This is **not** a guarantee of fair market/NAV pricing.
5. Bound quoted buys to 100 USDC input and sales to 100 USDC expected proceeds.
   These are per-quote application limits, not daily limits or an onchain budget.
6. Enforce 0.1–1% slippage, a positive minimum output, a 45-second quote lifetime
   and 60-second onchain deadline. The destination is always the signing wallet.
7. Before writes, recheck wallet, network, catalogue, approval and quote expiry.
   Insufficient balance fails before token approval. Approvals are exact amounts;
   an existing insufficient nonzero allowance is reset first.
8. Before the swap, recheck allowance and simulate the exact fixed-router call.
   Show the real-money confirmation separately from approval.
9. Record sender, target and exact economic calldata against the stored wallet-owned quote.
   A canonical ERC-8021 builder-attribution suffix is accepted, not arbitrary
   trailing bytes or modifications to swap arguments.
   Verify actual output from token Transfer logs. History stays pending until
   Base's safe block includes the receipt; unconfirmed receipts are not final.

The transaction hash is shown immediately, with a wallet-scoped browser recovery
journal. The server anchors the original sender and nonce while that transaction
is still visible to the RPC. Wallet speed-up hashes are discovery hints, never
proof of success: the server verifies the sender, nonce, fixed router, zero ETH
value and exact quoted economic calldata (plus canonical ERC-8021 attribution).
An identical repriced swap is recorded once under its actual mined hash, retaining
the original and observed replacement links. Cancellation and changed transactions
are labelled separately and never count as successful stock trades. All terminal
outcomes wait for a canonical receipt at or below Base's safe block.

Recovery after reload needs only the original wallet's signed-in session, not a
current trading grant. If its nonce was consumed without a wallet callback, the
server searches bounded pages of blocks and persists safe progress. Browser
retries and server history polling never submit transactions. If original evidence
was never anchored and the RPC has already forgotten it (including legacy browser
journals), the relationship cannot be proven: keep both hashes, report the
verification failure and do not guess or resend. Recording failures likewise never
trigger automatic swap resubmission.

The ticket and final review show the remaining allowance reset, exact approval
and swap network costs separately. Each includes L2 execution, L1 data and any
operator fee, estimated read-only with viem's OP Stack APIs on Base. Connector
attribution calldata is included. Arithmetic remains bigint wei throughout.
Pool fees are already included in the quote; the pilot adds no BasePay service
fee. Network fees are paid separately in ETH.

Missing components are explicitly unavailable, not zero, and prevent a full
total from being displayed. In particular, swap execution may be unavailable
until approval confirms, and zero-first tokens may need their reset confirmed
before approval can be estimated. No approval or swap is submitted to obtain
an estimate. Operator parameters are independently checked because viem can
return zero on failed operator reads. Account/network/quote changes invalidate
estimates; preparation and receipts trigger refreshes, and 15-second polling
refreshes external allowance changes, fee conditions and ETH. Signing performs
a fresh full-fee/balance check for the next transaction and blocks unavailable
costs or insufficient ETH. These are current estimates, not a guaranteed
maximum: the wallet supplies final gas settings and actual fees may differ.

After inclusion, each reset, approval and swap in the transaction list shows its
reviewed estimate and actual receipt-paid ETH cost separately, including reverted
transactions. A fresh pre-signing safety estimate does not overwrite the estimate
the user reviewed. Swap history persists that client-reported review separately
from server-verified paid fees; the browser recovery journal retains the review
when recording fails. History excludes approval/reset costs: they are not folded
into the swap fee, and neither pool nor service fees are network fees. A confirmed
cancellation or changed-economics replacement has its paid fees labeled as
replacement-transaction costs, not as a completed swap. The original reviewed
swap estimate is preserved when reconciliation changes the stored hash.

Actual execution cost is `gasUsed * effectiveGasPrice`; actual L1 data cost is
the receipt's `l1Fee`, not a reconstruction from L1 gas fields. Raw receipts are
read through viem's `request` API because its Base formatter currently omits
operator fields. Operator charges use receipt parameters with the appropriate
Isthmus or Jovian rules. A Jovian receipt marker or a historical oracle read at
the receipt block establishes the rule; today's parameters are never applied to
an older transaction. See the [Isthmus fee specification](https://specs.optimism.io/protocol/isthmus/exec-engine.html#fees)
and [Base's Jovian operator formula](https://docs.base.org/upgrades/jovian/exec-engine#operator-fee).
Missing receipt components remain unavailable, not zero, even when a provider
omits fields for an uncharged operator configuration. Partial fees never produce
a full paid total. Old/incomplete history fees are retried read-only, with pending
outcome reconciliation taking priority; no transaction is sent to measure fees.

Allowance revocation is available even after pilot access expires or is revoked.
Grant revocation prevents new application quotes/preparations; it does not
invalidate a transaction already signed, revoke ERC-20 allowances, or prevent
anyone using the public Aerodrome router outside StockFlow.

## Boundaries

- The local allocation planner and Sepolia virtual sandbox remain separate.
- Local rules do **not** constrain these manually signed trades.
- No autonomous trading, delegated swap authority, unattended scheduling,
  primary issuance/redemption or universal jurisdiction eligibility is claimed.
- This is an operator-controlled pilot, not an independently audited public
  brokerage or a statement that every listed asset is tradeable/liquid.
- Replacement discovery depends on RPC availability and original evidence.
  Unknown/unverifiable relationships remain explicit rather than being counted as
  a successful stock trade.

## Verification

Fee-reporting checks (mocked chain reads and temporary development database rows;
no public-chain transactions):

```sh
pnpm --filter @workspace/base-pay exec vitest run --config vitest.config.ts test/stockflow-network-fees.test.ts test/stockflow-network-fees.integration.test.tsx
pnpm --filter @workspace/scripts run test:stockflow-fees
```

Backend checks (ephemeral unfunded test accounts; no public-chain writes):

```sh
pnpm --filter @workspace/api-server run test:stockflow-replacements
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/test/stockflow-pilot.test.ts --live
```

The replacement regressions mock all chain reads, exercise real history routes
and development-database transactions, and clean up their ephemeral rows. They
cover attribution validation, speed-ups, self-cancellations, changed calls,
safe/canonical receipts, dropped originals after anchoring, resumable discovery,
concurrent idempotent retries, wallet isolation and recovery without eligibility.
Frontend wallet mocks cover chained replacements, reloads, recording failures,
account/network changes and prevention of duplicate submissions.

This covers session challenge replay/concurrency, no automatic admin approval,
review expiry/revocation, region/config denial, exact decimal parsing, pool-spot
impact, real mainnet buy/sell quotes, canonical attribution matching and the
pilot quote cap. Add `--http` to exercise actual running development API
sign-in, self-approval denial, a live decimal quote, insufficient-balance
rejection and revocation using an automatically cleaned ephemeral fixture:

```sh
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/test/stockflow-pilot.test.ts --http
```

Browser verification covered connection, actual challenge signing, denied
access, a temporary test grant, a live quote, unfunded preparation rejection,
grant removal and sign-out. No public-chain transaction was broadcast during
those browser checks; the separately authorized real trade is linked above.

Frontend regressions:

```sh
pnpm --filter @workspace/base-pay exec vitest run
```

Official integration sources:
- https://github.com/aerodrome-finance/slipstream
- https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks
- https://www.coinbase.com/tokenize
