# StockFlow security and limitations

[Documentation hub](README.md) · [Detailed pilot controls](../stockflow-mainnet-pilot.md)

## Eligibility is not established by a wallet connection

Permissionless transfers, catalogue listing, non-US residence and an operator
checkbox do not independently establish eligibility to offer or trade a stock
product. The operator remains responsible for investor status, issuer holder/
transfer restrictions, sanctions and local requirements.

The pilot uses an explicit supported-country policy, expiring reviewed grants
and an enable switch. Public users cannot grant themselves access. It does not
implement full KYC, IP geofencing, licensing or issuer onboarding.

## Signing and custody

Normal trades use the connected wallet, not a general server signer. Pilot login,
income-read proofs, policy snapshots and proposal reviews are different
authorizations. None can substitute for a wallet-confirmed token approval/swap.

Secure HttpOnly sessions, single-use challenges, Origin checks and rate limits
help protect API operations, but they are not a complete security audit.
Keep private keys, session cookies and secret values out of GitHub, screenshots,
URLs, logs, browser storage and documentation.

Keep administrative ownership separate from hot-relayer duties. Observing a
wallet's public history does not prove its private key was never exposed.
The explicitly approved server-signed smoke test was an operator exception,
not a standing trading permission or the app's user-flow design.

## Swap and allowance controls

- Restrict execution to the intended Base network, token pair, factory/router,
  signer recipient and exact economic calldata.
- Use live quotes, minimum output, short expiry/deadline and pre-swap simulation.
- Exact new approvals reduce standing allowance. An existing larger allowance
  can still exist; the user can explicitly revoke it.
- Reject insufficient token balance before requesting an approval.
- Unknown fee components are unavailable, not zero. ETH is needed in addition
  to the input token. Estimates are not guaranteed maximums.
- Pilot revocation does not revoke token allowances, undo signed transactions
  or block permissionless DEX use outside the application.

The per-quote 100 USDC cap is not a chain-enforced daily spending limit.
Pool-spot impact checks are not a guarantee of fair NAV, issuer solvency,
market quality, legal title or redemption.

## History, replacement and fee integrity

Verify sender, router, quote ownership, token output and canonical receipt.
Builder attribution must not relax economic-parameter matching. A speed-up hint
is not proof of success; changed/cancelled transactions must remain separate.
Unknown outcomes and failed recording must never trigger automatic resubmission.

Mined, safe and finalized are distinct. Paid fee totals require actual receipt
execution and L1 charges plus independently established operator treatment.
Missing receipt fields must not be reconstructed as a false complete zero.
Historical fork/fee rules must be checked at the receipt block.

## Income safety

Incoming transfers are not necessarily economic income. Receipt discovery checks
canonical successful transfers and confirmations, but reorg/RPC failures still
require explicit states and revalidation. A reviewed proposal is not a trade.

Proposal allocations use exact integer arithmetic and cumulative daily planning
limits. Dismissal or invalidation does not recycle that day's budget. Policy
changes do not silently reallocate prior receipts. EURC cannot fund a USD proposal
without a verified exchange rate.

The interactive ledger has bounded scanning/revalidation; it is not an
unbounded background indexer. See [receipt and reorg handling](../stockflow.md).

## Testing is not an audit

Mocked regressions, read-only Mainnet quotes and one successful funded trade
provide different evidence. None proves every asset, RPC, wallet type, market
condition or jurisdiction works. A new vault, autonomous executor or expanded
custody/permission model requires separate design and independent review.
