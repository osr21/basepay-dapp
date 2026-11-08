# BasePay StockFlow

StockFlow is available in BasePay at `/stockflow`. It includes a local allocation
planner, a separate virtual Sepolia sandbox, and an **operator-approved Base
Mainnet trading pilot**. See [Mainnet pilot](stockflow-mainnet-pilot.md) for
real trading, access controls, operational setup and limits. It is not an
unattended trading service or a generally available licensed stock brokerage.

Start with the [StockFlow documentation hub](stockflow/README.md) for user and
operator guides, architecture, API documentation, testing and the verified
[Mainnet smoke trade](stockflow/mainnet-test-2026-11-08.md).

## What works

- Wallet-confirmed mainnet USDC buys and stock sales for reviewed, approved pilot
  wallets, using the deployed Aerodrome router; no new stock contract deployment.
- A live, paginated Coinbase tokenized-stock catalogue, refreshed through the API.
- Public Base wallet stock balances, including B20 share-equivalent balances.
- Explicit missing, stale and partially unavailable data states.
- Browser-local allocation planning rules: create, edit, revoke, delete, income
  percentage, allocation weights, per-purchase maximum, daily maximum and expiry.
- Manually entered income previews and a local audit history.
- Read-only Base receipt ingestion for incoming USDC and EURC, including paid
  BasePay payment requests with an independently verified transfer.
- Wallet-scoped, PostgreSQL-persisted receipt history, an explicitly saved
  income-policy snapshot, allocation proposals and manual review decisions.
- A separately deployed, wallet-owned Base Sepolia sandbox with onchain limits,
  expiry, revocation and minimum-output/deadline checks.

Planning rules are not transaction authorizations. Each preview assumes the full
daily budget is available; it does not reserve or track spending across previews.
Local rules and manual-preview history do not synchronize across devices.
Disconnected drafts are separate from connected-wallet rules, and unreadable
saved data is not overwritten. The received-income workflow below has separate
server persistence and cumulative daily planning limits.

## Received payments and allocation proposals

1. Connect the recipient wallet. Choose a local policy and use **Use selected
   local policy for income** to sign and save its complete snapshot to the API.
   This is a planning rule, not spending authority.
2. **Unlock and sync receipts** signs a short-lived ownership message, not a
   transaction. The same read proof can be reused for four minutes. While
   unlocked, saved state refreshes every 30 seconds and chain synchronization
   runs every minute; expired access never prompts for a new signature by itself.
3. Synchronization discovers `Transfer` logs from the canonical USDC and EURC
   contracts on Base Mainnet (8453). It verifies successful transaction receipts,
   recipient, positive amount, canonical block hash and at least **12
   confirmations**. Pending confirmations are visible but do not produce
   proposals. Self-transfers are excluded. Twelve confirmations are a confidence
   threshold, not a promise of finality.
4. The first automatic scan starts roughly 24 hours before the first sync.
   Each sync scans at most 2,000 blocks with a 64-block overlap. The UI exposes
   start/cursor/head and incomplete catch-up; repeat sync or leave the page
   unlocked to catch up. A transaction hash can be supplied to verify older
   transfers. Paid BasePay requests with hashes are checked independently of the
   scan window. A manual paid mark, ETH request or insufficient transfer is
   **not** a verified BasePay receipt.
5. Confirmed USDC receipts create one immutable, reviewable proposal per incoming
   transfer event under the saved policy. Calculations use integer micro-units,
   basis points and rounded-down cents, honoring income percentage, asset
   weights, per-purchase maximum, cumulative UTC-day maximum and expiry. All
   policy versions share the wallet's daily planning budget. Dismissed and
   invalidated proposals still count that day; no budget is recycled.
6. EURC is recorded with its original denomination and a **blocked proposal**:
   there is no verified EUR/USD rate, so the system does not pretend one EURC is
   one dollar. Zero/sub-cent or exhausted-budget allocations are also blocked.
7. **Mark reviewed — no trade** and **Dismiss proposal** sign explicit review
   decisions. The API rechecks chain state before accepting them. Neither action
   sends tokens, requests an allowance, creates an execution authorization,
   invokes a relayer or places a trade.

The saved income policy is a separate snapshot: local edits, revocation or
deletion do not change it implicitly. Save the updated selected policy, or use
**Pause new proposals** to stop new proposals and invalidate pending ones.
Saving an identical snapshot is idempotent. Changing policies never reuses
already proposed income, and existing proposals retain their original rules.
The saved snapshot and review decisions remain available in a fresh browser
after the same wallet proves ownership, even when no local policy exists there.

Receipt identity includes chain, normalized recipient wallet, transaction hash,
transaction-local log offset and token address. The local offset is important:
the global log index can change when a transaction moves to another block.
Overlapping scans, a BasePay request and a manually imported hash therefore
cannot count the same payment twice. Multiple incoming events in one transaction
are distinct; multiple request links to one event do not multiply its value.

Every sync revalidates all known transaction receipts, including ones outside the
current scan window. A missing/reverted/noncanonical receipt or confirmation
regression invalidates its proposals and clears their prior review. A restored
transaction does not silently generate or approve another proposal. Changed
cursor block hashes rewind discovery to the original scan start. Chain movement
during verification or an RPC failure aborts the whole sync without advancing
the cursor or replacing saved state. Persisted rows are not evidence of current
finality; the UI shows the last verification time and review requires a new check.

All changes to a wallet ledger hold a PostgreSQL row lock and atomically commit
cursor, receipts, proposals and decisions, so concurrent sessions/API processes
cannot duplicate proposals. Request proofs bind the wallet and action; policy
and review signatures also bind the exact payload. React Query keys are
wallet-scoped and exclude signatures; switching/disconnecting wallets remounts
the income view and discards in-flight signing results.

This initial interactive ledger has a safety bound of 5,000 distinct transaction
hashes per sync, beyond which it fails explicitly without saving partial state.
It is not an unbounded historical indexer or an unattended background service.
Incoming token transfers may include bridges, swaps or internal movements, not
necessarily economic income: human review remains required. Proposals are USD
amounts only, not trade quotes, share quantities or reserved funds.

### Income API

Contracts live in `lib/api-spec/openapi.yaml`; React clients and server schemas
are generated with `pnpm --filter @workspace/api-spec run codegen`.

- `GET /api/stockflow/income/{wallet}` — saved ledger; `stockflow-income` read
  proof in `signature` and `timestamp` query parameters.
- `POST /api/stockflow/income/{wallet}/sync` — read-only ingestion; the same
  proof in the body and optional historical `txHash`.
- `PUT /api/stockflow/income/{wallet}` — save `{policy, signature, timestamp}`;
  `policy: null` pauses; action `stockflow-policy` signs a `policy` field
  containing the canonical JSON snapshot in contract property order.
- `PATCH /api/stockflow/income/{wallet}/proposals/{id}` — body
  `{status: "reviewed" | "dismissed", signature, timestamp}`; action
  `stockflow-review` signs ordered fields `id`, `status`.

The `stockflow_income` table is added using the existing Drizzle schema-push
workflow; `scripts/post-merge.sh` applies it after merge. No existing payment
request state or statistics are used as financial accounting authority.

## The sandbox is not a stock exchange

The sandbox has virtual accounting balances, not ERC-20 tokens, USDC or actual
shares. Its fixed price is illustrative: 100 demoUSD per demo share. The initial
balance is 1,000 demoUSD. There is no deposit, withdrawal or redemption path.

The connected user deploys and signs transactions themselves, using their own
Base Sepolia ETH for gas. The application does not sign with any server key.
The constructor rejects every chain except Base Sepolia (84532), including Base
Mainnet (8453). This contract demonstrates constraints on owner-initiated actions;
it is not delegated trading authority for an autonomous agent.

Saving a new sandbox policy does not erase spending in the current anchored day.
Revoking then re-enabling a policy does not reset that budget either.

## Real stock data

Reference API: https://api.coinbase.com/v1/tokenized-stocks

The API is read-only. Catalogue presence does not establish user eligibility,
liquidity, execution availability or redeemability. Missing NAV is not zero.
Reference NAV is already multiplier-adjusted; dividing a dollar amount by NAV
estimates token units, not underlying share units. Current share-equivalent
holdings are read with B20 `balanceOfUI`.

NAV timestamps older than 24 hours are treated conservatively as stale, including
weekends. This does not mean the feed is defective; stock feeds may retain their
last values outside trading hours. Reference prices are never execution quotes.
Public positions are read at one Base block, and failed reads are disclosed.

## Income proposals are not trades

Live stock trading is not implemented by the received-income workflow. Real
execution requires a supported venue, asset/router allowlists, bounded allowances,
minimum-output checks, quote expiry, explicit destination ownership, robust
idempotent accounting, appropriate jurisdiction/eligibility controls and review.
The existing AgentSpendPolicyV1 only authorizes transfers and must not be
represented as enforcing swap-output constraints.
The separate [Mainnet pilot](stockflow-mainnet-pilot.md) provides manual execution;
reviewing an income proposal does not invoke it.

The Stocks Maxxing campaign excludes products enabling trading for US users;
non-US availability still depends on the applicable product and local rules.
Neither this demo nor entering a competition establishes legal compliance.

## Verification

Compile the sandbox:

    node scripts/src/compile-stockflow.mjs

Local EVM tests (no live transactions or funding):

    node scripts/test/stockflow-sandbox.test.mjs

Planning and storage tests:

    pnpm --filter @workspace/base-pay exec vitest run --config vitest.config.ts test/stockflow-logic.integration.test.tsx

Receipt/reorg/replay, exact amounts, concurrent sessions, PostgreSQL persistence,
proof isolation and bounded scanning (uses dev DB with isolated random wallets;
no live chain transactions):

    pnpm --filter @workspace/scripts run test:stockflow-income

Income UI, delayed account switching, canonical policy signing and cross-session
rehydration:

    pnpm --filter @workspace/base-pay exec vitest run --config vitest.config.ts test/stockflow-income.integration.test.tsx

Typecheck the changed apps:

    pnpm --filter @workspace/base-pay run typecheck
    pnpm --filter @workspace/api-server run typecheck
