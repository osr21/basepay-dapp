# StockFlow operator guide

[Documentation hub](README.md) · [Security](security-and-limitations.md)

## Configuration

| Setting | Meaning |
| --- | --- |
| `STOCKFLOW_PILOT_ENABLED` | Exactly `true` enables the pilot, subject to valid admin configuration |
| `STOCKFLOW_PILOT_ADMIN_WALLETS` | Comma-separated public administrator addresses |
| `SESSION_SECRET` | Existing strong server secret for signed wallet-session cookies |
| `DATABASE_URL` | Existing PostgreSQL connection, supplied securely for the intended environment |

Missing/invalid administrators, a disabled switch or invalid access deny trading.
Keep secrets in the deployment's secret store; never commit their values,
private keys, cookies or environment files. The public allowlist is configuration,
not proof that its members are eligible to trade.

StockFlow's normal manual trading flow does not require a stock-trading server
private key. Other BasePay features have their own configuration requirements.
Use a separate administrator identity rather than treating a hot relayer as a
general administrative owner.

## Add or edit a participant

1. Connect an administrator wallet and sign in under **Base Mainnet**.
2. Open **Pilot participants → Add wallet**.
3. Enter the participant's public address, actual reviewed two-letter country
   code and a grant length of **1–30 days**.
4. For the United Kingdom use **GB**. Updated clients/API also accept **UK** and
   save it as GB. `Europe`, `Asia` and `any` are not countries.
5. Complete the required participant, investor, issuer, jurisdiction and sanctions
   review outside this simple form. Confirm the operator-review checkbox only
   when that work has actually been completed.
6. Choose **Grant trading access** and save. Confirm the participant appears as
   active with the intended expiry. The API records the administrator and
   previous/new states.

An administrator is not automatically approved to trade. Participants cannot
self-approve. A country code and checkbox are not KYC, geofencing, a licence or
independent legal clearance. Europe and Asia are target regions, not a statement
that all investors or countries in those regions are permitted.

Country policy is maintained in the API's supported/restricted sets. Do not
remove a restriction simply to make a test pass.

## Expire, revoke or pause

- Edit the grant or use **Revoke** to stop new application quotes/preparations.
- Turning off the pilot blocks new application trading.
- Revocation does not cancel a transaction already signed, revoke an ERC-20
  allowance or prevent using a permissionless DEX outside StockFlow.
- The original wallet must remain able to reconcile past trades after revocation.
- Reviewing income proposals is separate from participant approval and does not
  trigger execution.

## Preview versus published app

Approve the wallet in the app that will execute the trade. Development/preview
and production use environment-specific databases and sessions. A successful
production approval can coexist with no preview participant record.

When a user reports that approval was completed, verify the app URL and correct
database before asking for another review. Never copy grants between environments
or manufacture a signed administrator session as a shortcut.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP 401 / not signed in | Correct wallet, normal login challenge, session age and same-origin cookies |
| HTTP 403 / not approved | Correct environment, global switch, wallet, review, grant expiry and country policy |
| Country/review HTTP 400 | Actual supported ISO code; GB/UK normalization; review checkbox; 1–30 whole days |
| No executable quote | Selected asset, direct USDC liquidity, pause status, RPC availability and impact limit |
| Quote expired / HTTP 409 | Request a fresh quote; do not retry an existing submitted order |
| Insufficient balance | Correct input token and ETH on Base; do not submit approval just to test funding |
| Partial fee estimate | Missing execution/L1/operator data; do not treat missing data as zero |
| Delayed history | Original/replacement hashes, canonical receipt and safe-block progress |

Old published versions may not include a newly merged UI/API fix. Updating
documentation or the preview is not itself an application release.
