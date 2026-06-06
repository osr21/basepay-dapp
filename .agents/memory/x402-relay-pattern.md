---
name: x402 relay route pattern
description: How to wire up an x402-gated Express route on Base Mainnet using @x402/express + @x402/evm/exact/server.
---

## Package imports (confirmed working)

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
```

Add `@x402/core` explicitly to api-server package.json (`pnpm --filter @workspace/api-server add @x402/core`) even though it's a transitive dep of @x402/express, to avoid pnpm strict-mode import errors.

## Initialization pattern

Must lazy-initialize the middleware (not at module load time) so the env var `FEE_COLLECTOR_ADDRESS` is resolved at runtime:

```ts
let _x402Middleware: ReturnType<typeof paymentMiddleware> | null = null;

function getX402Middleware() {
  if (_x402Middleware) return _x402Middleware;
  const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register("eip155:8453", new ExactEvmScheme());
  _x402Middleware = paymentMiddleware({
    "POST /v2/relay": {
      accepts: { scheme: "exact", price: "$0.001", network: "eip155:8453", payTo: PAY_TO },
    }
  }, resourceServer);
  return _x402Middleware;
}
```

## Route registration

The route path in the paymentMiddleware config must match the Express route **without** the `/api` prefix (since the Express router is mounted on `/api`):
- Config key: `"POST /v2/relay"`
- Express route: `router.post("/v2/relay", ...)`

## Free info endpoint

Always add a GET info endpoint (`GET /v2/relay/info`) that describes x402 payment requirements without requiring payment — lets clients inspect requirements before sending.

## FEE_COLLECTOR_ADDRESS

`FEE_COLLECTOR_ADDRESS` env var = the address that receives USDC for each paid relay. If not set, the middleware is skipped with a warning (useful for local dev).
