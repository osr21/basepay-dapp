# StockFlow development and testing

[Documentation hub](README.md)

## Code availability

The paths below describe the StockFlow-enabled pnpm monorepo implementation.
This documentation update does not upload missing application source into an
older GitHub checkout. Confirm your checkout includes the listed modules before
trying to run them; use the current development workspace otherwise.

| Area | Implementation location |
| --- | --- |
| Main page and pilot UI | `artifacts/base-pay/src/pages/StockFlow.tsx`, `src/components/stockflow/` |
| Trading/recovery controller | `artifacts/base-pay/src/lib/useStockflowTrading.ts`, `stockflow-pending.ts` |
| Quote/contract and fee checks | `artifacts/base-pay/src/lib/stockflow-trade-contract.ts`, `stockflow-network-fees.ts` |
| Market execution verification | `artifacts/api-server/src/lib/stockflow-market.ts` |
| Pilot sessions/access | `artifacts/api-server/src/lib/stockflow-pilot-access.ts` |
| Pilot/trading API | `artifacts/api-server/src/routes/stockflow-pilot.ts` |
| Income policy and ingestion | `artifacts/api-server/src/lib/stockflowIncome.ts`, `stockflowIncomeLogic.ts`, `routes/stockflowIncome.ts` |
| API contract and DB schema | `lib/api-spec/openapi.yaml`, `lib/db/src/schema/` |
| Sandbox | `contracts/StockFlowSandbox.sol`, `scripts/src/compile-stockflow.mjs` |

## Setup

1. Install the workspace's Node/pnpm versions and run `pnpm install`.
2. Supply the existing database/session configuration securely and configure
   public pilot administrator addresses. See the [operator guide](operator-guide.md).
3. Regenerate clients and workspace declarations after API/schema changes:

   ```sh
   pnpm --filter @workspace/api-spec run codegen
   ```

4. Apply reviewed, non-destructive schema changes to the intended **development**
   database using the existing workflow:

   ```sh
   pnpm --filter @workspace/db run push
   ```

   Do not run a force push against a production database. Keep development
   fixture grants separate from real production approvals.
5. Run the configured API and BasePay web workflows. Their commands are
   `pnpm --filter @workspace/api-server run dev` and
   `pnpm --filter @workspace/base-pay run dev`. Managed workflows supply the
   necessary ports/base paths; do not create competing duplicate servers.

Use the artifact's routing/base-path conventions and relative browser API URLs.
Never hardcode a localhost backend or a temporary preview domain into the app.

## Checks that do not spend public-chain funds

```sh
pnpm run typecheck:libs
pnpm --filter @workspace/base-pay run typecheck
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/base-pay exec vitest run

pnpm --filter @workspace/scripts run test:stockflow-income
pnpm --filter @workspace/scripts run test:stockflow-fees
pnpm --filter @workspace/api-server run test:stockflow-replacements
node scripts/test/stockflow-sandbox.test.mjs
```

Some suites use temporary development DB fixtures and remove them afterward.
Never point fixture tests at production or replace the real administrator to
make a test pass.

Read-only Mainnet quotes and development HTTP checks:

```sh
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/test/stockflow-pilot.test.ts --live
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/test/stockflow-pilot.test.ts --http
```

`--live` uses chain reads/`eth_call`; it does not submit a transaction.
`--http` requires the running development API and tests signed login, denied
self-approval, quote amounts, insufficient-balance rejection and revocation
with an unfunded ephemeral fixture.

Compile the sandbox with `node scripts/src/compile-stockflow.mjs`. Its constructor
rejects Mainnet; local EVM tests must use a compatible compiler target.

## Real Mainnet smoke tests

The [documented historical trade](mainnet-test-2026-11-08.md) was separately and
explicitly authorized. Its one-off script is not a reusable CI job, production
signing feature or standing permission to use a configured private key.

For any future real test, obtain fresh authorization for the wallet, asset,
amount, recipient, approval and gas budget. Use an already reviewed grant in the
correct app, revalidate the quote/nonce/funding, retain every hash and never
resend an ambiguous transaction. Do not fund random test fixtures.

## Documentation maintenance

Update the OpenAPI contract before regenerating clients. Keep real trade
evidence distinct from mocked tests. After a merge, stale generated declarations
can look like missing exports; regenerate/build libraries before changing
working application code to compensate.
