# BasePay StockFlow

**Implementation snapshot: 8 November 2026**

[Open StockFlow](https://base-pay.replit.app/stockflow)

StockFlow connects received-payment planning with an operator-approved,
non-custodial tokenized-stock trading pilot on **Base Mainnet**. It also includes
a local allocation planner and a strictly separate Base Sepolia sandbox.

The normal trading flow requires the connected wallet to confirm each token
approval and swap. It is **not** autonomous investing, primary stock issuance,
redemption, a promise of liquidity or a generally available licensed brokerage.

## Documentation

| Guide | Contents |
| --- | --- |
| [User guide](user-guide.md) | Wallets, funding, buying, selling, fees and recovery |
| [Operator guide](operator-guide.md) | Configuration, participant reviews, expiry, revocation and troubleshooting |
| [Architecture and contracts](architecture.md) | Components, data, networks, deployed dependencies and contract boundaries |
| [API reference](api-reference.md) | Catalogue, sessions, pilot administration, trades and income endpoints |
| [Development and testing](development-and-testing.md) | Source layout, setup, checks and safe testing |
| [Security and limitations](security-and-limitations.md) | Eligibility, signing, allowances, finality and operational risks |
| [Verified Mainnet test](mainnet-test-2026-11-08.md) | Real 0.10 USDC NVDAc purchase, transaction links and paid fees |
| [Detailed pilot implementation](../stockflow-mainnet-pilot.md) | Quote controls, replacements and fee accounting |
| [Planner, income and sandbox reference](../stockflow.md) | Receipt verification, proposals, local planning and virtual accounting |

## Four separate workflows

| Workflow | Persistence | Moves real funds? |
| --- | --- | --- |
| Local allocation planner | Wallet-scoped browser storage; disconnected drafts are separate | No |
| Received-income proposals | Wallet-proven PostgreSQL ledger and saved policy snapshot | No; review is not execution |
| Base Mainnet pilot | Expiring operator grants, stored quotes and verified trade history | Yes, through individually confirmed swaps |
| Base Sepolia sandbox | User-deployed, owner-controlled demo contract | Only testnet gas; balances and shares are virtual |

### Quick start

1. Connect an EOA or EIP-7702 wallet on Base Mainnet.
2. Sign in under **Base Mainnet**. This message creates a session, not a trade.
3. Obtain an operator-reviewed participant grant. Administrators are not
   automatically trading participants.
4. Hold native Base USDC for buys and Base ETH for network fees.
5. Select a supported stock, obtain a live quote, review costs and confirm the
   exact approval and swap. See the [user guide](user-guide.md).

Current pilot bounds are **100 USDC per quote**, 0.1–1% slippage, a 45-second
quote lifetime and a 60-second swap deadline. These are not a daily onchain
budget. Not every catalogue asset has a supported executable pool.

## Evidence and deployment status

On 8 November 2026, an explicitly authorized test bought **0.00053199 NVDAc for
0.10 USDC** on Base Mainnet. Both approval and swap succeeded, and the router
allowance returned to zero. [Receipts and methodology](mainnet-test-2026-11-08.md).
One successful test does not establish universal asset support or legal clearance.

This documentation describes the current implementation. A published app or
older source checkout may lag this snapshot. A documentation commit does not
deploy the application, deploy contracts or grant trading permissions.
