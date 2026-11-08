# StockFlow source publication and setup

[Documentation hub](README.md) · [Development checks](development-and-testing.md)

## Review boundary

This source update is based on the public repository's latest `main` after the
StockFlow documentation publication. It adds the current StockFlow
implementation without importing the development workspace's commit history.
It does not merge or release the application.

Included:

- StockFlow's page, planner, pilot administration, trading/recovery controller,
  income panel, reviewed fee estimates and receipt-paid fees.
- Stock catalogue/positions, pilot access, quote/prepare/history and income API
  modules, with only their router registration and income write-rate limiter
  added to the existing API.
- StockFlow-only OpenAPI additions and regenerated React/Zod source outputs.
  Unrelated API contracts remain unchanged.
- Six StockFlow database schemas and the shared exact-integer Base fee library.
- Testnet-only sandbox Solidity, reproducible compiler and local EVM tests.
- Unfunded frontend and API tests plus their required test dependencies.

Shared files are edited narrowly: one page registration/navigation entry,
scoped styles, Base Sepolia chain configuration, the existing `ApiError`
re-export, library references, package scripts and lockfile additions. Existing
wallet connectors and unrelated application routes are preserved.

Excluded from the changes:

- Private keys, environment files/values, cookies and session credentials.
- `.agents`, personal attachments, recordings and unrelated workspace features.
- Build output, logs, database fixtures and compiled sandbox bytecode.
- The separately authorized, one-off Mainnet signing script.

The previously published documentation and unrelated repository files are
preserved. OpenAPI-generated TypeScript is committed as source; generated
runtime sandbox bytecode is ignored and rebuilt from Solidity instead.

## Install and generate

Use Node.js 24 and pnpm 10. Run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/scripts run compile:stockflow
```

The sandbox compiler targets Paris for local EVM compatibility. Frontend
`predev`, `prebuild` and `pretypecheck` hooks compile it automatically;
`test:stockflow` does so too. Direct sandbox or Vitest invocations require the
compile step first. Compilation is not a deployment and needs no signing key.

## Schema changes

No application or production database migration is performed by this source PR.
Before starting an updated API against an existing database, review the Drizzle
diff for the intended environment.

A database based on the older public source needs these new tables:

| Table | Purpose |
| --- | --- |
| `stockflow_pilot` | Reviewed, expiring participant grants |
| `stockflow_challenges` | Persisted, single-use wallet login challenges |
| `stockflow_quotes` | Expiring, wallet-bound executable quote payloads |
| `stockflow_trades` | Canonically verified trade history and fee data |
| `stockflow_pilot_audit` | Administrator decisions and previous/new state |
| `stockflow_income` | Wallet-locked receipts, policies, cursor and proposals |

Keep the quote foreign key and wallet/expiry indexes defined by the schemas.
`stockflow_trades.network_fees` and `reviewed_swap_fee` are nullable JSONB:
an environment with an earlier StockFlow schema may need only those columns
added. Do not fill missing historical fees with zero or overwrite actual paid
fees with reviewed estimates.

For a disposable or intended development database, after securely configuring
its connection:

```sh
pnpm --filter @workspace/db run push
```

This project uses Drizzle schema push rather than a versioned migration baseline.
For production, take a backup and review/apply the corresponding additive
DDL through the operator's normal migration process. Do not use `push-force`,
drop existing tables or copy participant grants between environments. Empty
tables must remain empty until normal wallet/operator actions create records;
tests are not seed data.

## Configuration and operating limits

Supply `DATABASE_URL` and a strong `SESSION_SECRET` of at least 32 characters
through the environment's secret store. Configure public administrator addresses
with `STOCKFLOW_PILOT_ADMIN_WALLETS`. Keep `STOCKFLOW_PILOT_ENABLED` off unless
the operator intentionally enables the reviewed pilot. Missing/invalid
administrators deny trading even when the switch is enabled.

No server trading private key is required for StockFlow: approval and swap are
manually confirmed by the user's wallet. Existing non-StockFlow BasePay features
retain their own configuration/startup requirements; this PR does not change
their relayer behavior. The API was not started with real credentials during
publication.

Serve the frontend and API on the same HTTPS origin (`/stockflow` and
`/api/stockflow/...`) for secure session cookies. Configure existing managed
workflows/ports as before. No contract address, deployment, environment secret,
grant or production setting is changed by opening or merging this PR.

## Verification performed

Checks ran against the isolated source-PR copy, not just the newer development
workspace:

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm --filter @workspace/base-pay run typecheck
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/base-pay run test:stockflow
pnpm --filter @workspace/scripts run test:stockflow-sandbox
pnpm --filter @workspace/scripts run test:stockflow-income
pnpm --filter @workspace/scripts run test:stockflow-fees
pnpm --filter @workspace/scripts run test:stockflow-pilot
pnpm --filter @workspace/api-server run test:stockflow-replacements
```

Results: 123 frontend tests; 10 income tests; 5 receipt-fee tests; 11 pilot
access checks; 13 replacement/recovery checks; 15 sandbox checks and rejection
of deployment on a **local** simulated Mainnet chain.

Database suites used a newly initialized, disposable localhost PostgreSQL
cluster. Its schema was created from the PR's Drizzle definitions; no configured
development/production database or existing participant data was used. Test
processes inherited no workspace secrets and used only synthetic session data,
ephemeral unfunded identities, mocked chain reads and a local EVM. The cluster
was stopped afterward.

Ganache reports that Node 24 uses its JavaScript transport fallback; the sandbox
checks still pass. Existing OnchainKit/wagmi peer warnings remain; this
publication does not change their versions or replace wallet integrations.
The full workspace typecheck is not claimed here; the targeted library, API and
frontend checks above are the verified publication scope.

## Automatic source checks

`.github/workflows/stockflow.yml` runs **StockFlow publication checks** on every
pull request, pushes to `main`, and manual dispatch. There is no path filter, so
shared dependency changes and documentation-only PRs receive the same check.
It uses Node 24, pnpm 10.26.1 and `pnpm install --frozen-lockfile`.

The job runs `pnpm ci:stockflow` in these separately reported phases:

- `safety`: checks that the runner strips inherited credentials, rejects
  non-disposable database targets, and blocks external network/live modes.
- `generated`: regenerates the OpenAPI client and Zod sources, then fails on any
  modified, deleted or untracked generated file. Run codegen and commit all
  output when changing `lib/api-spec/openapi.yaml`.
- `types`: checks only the root composite libraries, API server and BasePay;
  compiles the local sandbox artifact before checking the frontend.
- `local`: runs only StockFlow frontend tests and the in-process Ganache sandbox,
  including rejection on a locally simulated Mainnet chain.
- `database`: pushes the PR's Drizzle schema to a fresh PostgreSQL 16 service and
  runs income, paid-fee, pilot-access and replacement/recovery suites.

The database service is disposable and contains only synthetic fixtures. No
repository/environment secrets, relayer or administrator keys, funded accounts,
external API server, `--live`, `--http`, production database or deployment is
needed. Synthetic wallet identities sign only local authentication messages.
All chain reads use mocks; a Node preload rejects non-loopback fetch, HTTP(S)
and TCP access in check subprocesses, including test workers. This is an
accidental-regression guard, not a security sandbox for malicious PR code.
The workflow uses a read-only token and does not retain checkout credentials.

To reproduce locally, provision an **empty, disposable** loopback PostgreSQL
database named `stockflow_ci`, with user/password `stockflow_ci`, then run:

```sh
pnpm install --frozen-lockfile
pnpm ci:stockflow
# Or just one phase:
pnpm ci:stockflow -- local
```

The default target is port 5432. For a separate local cluster, set the non-secret
`STOCKFLOW_CI_DATABASE_URL` to
`postgresql://stockflow_ci:stockflow_ci@127.0.0.1:55432/stockflow_ci`.
Only a loopback target with that synthetic database/user/password is accepted;
URL query overrides are forbidden. The runner deliberately ignores a configured
`DATABASE_URL`, `SESSION_SECRET`, signing credentials and `NODE_OPTIONS`.
Never point it at an application database: the database phase creates schema and
writes test rows. GitHub removes the service when the job ends.

These checks do not restore the unrelated full-workspace typecheck and never
invoke the root `test`, application startup tests or signing/deployment scripts.
To require a green check before merging, an operator can select **StockFlow
publication checks** in GitHub branch protection; this workflow does not change
repository protection settings.

The CI runner was also checked against temporary regressions in an isolated
copy: a library type error, a one-wei fee miscalculation, an eligibility bypass
and an OpenAPI description change without committed regeneration each produced
a nonzero exit. Those probes were removed; they are not part of the source.

No funded test, `--live`/`--http` test mode, public-chain write, application
deployment, contract deployment or production migration was run. The previously
documented Mainnet trade remains historical evidence, not a test rerun.
