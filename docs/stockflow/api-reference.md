# StockFlow API reference

[Documentation hub](README.md)

Base path: **`/api/stockflow`**. On the published app this is
`https://base-pay.replit.app/api/stockflow`.

The implementation's source of truth is `lib/api-spec/openapi.yaml`; generated
clients live in `@workspace/api-client-react` and schemas in `@workspace/api-zod`.
Use the contract from the same application version as the server.

## Authentication

Pilot operations use a one-hour, Secure, HttpOnly, SameSite=Strict cookie scoped
to `/api/stockflow`. The cookie is issued only after a wallet signs the server's
single-use, expiring challenge. The challenge binds the domain, Base chain ID,
wallet and nonce. No bearer token or private key should be placed in browser
storage, request URLs or documentation.

```javascript
// walletClient and address come from the user's connected browser wallet.
async function call(method, path, body) {
  const response = await fetch(`/api/stockflow${path}`, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

const challenge = await call("POST", "/pilot/challenge", { address });
// Display/verify the intended domain, chain and wallet before signing.
const signature = await walletClient.signMessage({
  account: address, message: challenge.message,
});
const session = await call("POST", "/pilot/auth", {
  address, challengeId: challenge.id, signature,
});
// session.approved, not session.isAdmin alone, controls trading access.
```

This is an offchain login signature, not a token approval or order. Browser
mutations also enforce Origin checks and rate limits. Do not transfer cookies
between preview and production or log signatures/session material.

## Public market data

| Method | Path | Result |
| --- | --- | --- |
| GET | `/stocks` | Normalized stock catalogue and reference metadata |
| GET | `/positions/{wallet}` | Public onchain wallet holdings and read availability |

Missing reference prices are not zero. Catalogue presence is not evidence of
eligibility, executable liquidity or redemption rights.

## Sessions and administration

| Method | Path | Access / body |
| --- | --- | --- |
| GET | `/pilot/session` | Current session, administrator status and participant access |
| POST | `/pilot/challenge` | `{ "address": "0x…" }` |
| POST | `/pilot/auth` | `{ "address": "0x…", "challengeId": "…", "signature": "0x…" }` |
| POST | `/pilot/logout` | Clear this session cookie |
| GET | `/pilot/participants` | Signed-in administrator only |
| POST | `/pilot/participants` | Signed-in administrator; body below |

```json
{
  "wallet": "<participant address>",
  "countryCode": "GB",
  "days": 1,
  "approved": true,
  "reviewConfirmed": true
}
```

`reviewConfirmed` attests to the operator's completed review; this example is not
an eligibility determination. Country inputs are normalized to uppercase; `UK`
maps to `GB` in the updated implementation. Unsupported/restricted countries are
denied. Grant windows are 1–30 days. Revoke an existing participant with
`approved: false` and `reviewConfirmed: false`; the existing country/expiry is
preserved by the server. Administrator identity is derived from the signed
session, never from a caller-supplied `reviewedBy`.

## Manual trading

| Method | Path | Access / purpose |
| --- | --- | --- |
| POST | `/trading/quote` | Approved wallet; fresh executable quote |
| POST | `/trading/prepare` | Approved quote owner; funding/allowance and simulation checks |
| POST | `/trading/history` | Signed-in original wallet; verify/record a submitted transaction |
| GET | `/trading/history` | Private wallet-scoped history and reconciliation |

Example buy quote:

```json
{
  "stockAddress": "0xb20000000000000000000078ee7ce2fE4908108C",
  "side": "buy",
  "amount": "0.1",
  "slippageBps": 50
}
```

For a buy, `amount` is decimal USDC; for a sale it is decimal stock-token units.
It must remain a string: `"0.1"` is not `"100000"`. Quote raw amounts such as
`amountIn`, `amountOut` and `minimumOut` are integer strings with accompanying
decimals. Quotes also identify chain, wallet, token pair, router, factory, pool,
tick spacing, slippage/impact, block, expiry and deadline.

Preparation body: `{ "quoteId": "<id>" }`. The response includes the stored
quote, raw balance/allowance, `approvalRequired` and `simulated`. The API does
not broadcast an approval or swap. The client validates the fixed contracts
and economic parameters and obtains wallet confirmations.

Recording body: `{ "quoteId": "<id>", "hash": "0x…" }`. The newer contract also
supports `replacementHashes` hints and optional `reviewedSwapFee` metadata.
Hints/client estimates are not proof of execution or actual fees. Server checks
determine outcomes and paid-cost availability.

History statuses are `pending`, `confirmed`, `failed`, `cancelled` and `changed`.
Original/replacement links are retained. A revoked wallet can reconcile its
already signed transactions; it cannot initiate a new trade.

## Income ledger and proposal review

These endpoints use action-bound wallet ownership proofs, not the pilot session
as a substitute for their proof. Use the implementation's canonical signing
helpers and property order; do not invent the message format.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/income/{wallet}` | Read saved policy/ledger with `stockflow-income` proof |
| POST | `/income/{wallet}/sync` | Verify incoming receipts; optional historical `txHash` |
| PUT | `/income/{wallet}` | Save canonical policy snapshot, or `policy: null` to pause |
| PATCH | `/income/{wallet}/proposals/{id}` | Sign `reviewed` or `dismissed` decision |

Proofs bind the wallet, action and short-lived timestamp. Policy/review
signatures also bind the exact payload. See the
[detailed income API](../stockflow.md#income-api). None of these operations
requests a token allowance or submits a swap.

## Errors and safe retries

- **400:** invalid input, country, grant duration or missing review.
- **401:** missing/invalid/expired wallet authentication.
- **403:** administrator or current trading approval required.
- **404:** a wallet-owned quote/participant was not found.
- **409:** expired quote or already-submitted quote; reconcile instead of resend.
- **422:** quote/preparation cannot execute, including insufficient input balance.
- Configuration/RPC failures can also surface as service errors; never replace
  missing data with fabricated quotes, fees or success states.

Read/reconciliation retries never authorize another onchain transaction.
