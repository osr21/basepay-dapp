# AI Agent Payments (x402)

  > Added: July 2026 · Route: `/agent` · Files: `AgentWallet.tsx`, `x402relay.ts`

  ## Overview

  BasePay's AI Agent Payments page shows how autonomous AI agents can programmatically send USDC on Base **without holding ETH for gas** and **without any human approval**. It combines:

  - **EIP-3009** off-chain authorization — the agent signs a `TransferWithAuthorization` typed message (no wallet popup, no ETH)
  - **BasePay's gasless relay** — the relayer submits the transaction and pays gas
  - **x402 micropayment protocol** — the relay endpoint is itself gated by x402, so agents can pay per-call in USDC or use a `bpk_` API key

  ---

  ## How It Works

  ```
  Agent (EOA wallet, holds USDC on Base)
      │
      │  1. Sign EIP-3009 TransferWithAuthorization typed message
      │     (off-chain — no ETH, no UI interaction)
      │
      ▼
  BasePay Relay  POST /api/v2/relay
      │  Auth: X-API-Key: bpk_...    (option A)
      │  Auth: x402 payment header   (option B — $0.001 USDC per call)
      │
      │  2. Validate signature, balance, nonce
      │  3. Submit transferWithAuthorization on-chain
      │
      ▼
  Base Mainnet — USDC moves from agent → recipient in one tx
  ```

  ---

  ## Relay Endpoint

  ```
  POST /api/v2/relay
  GET  /api/v2/relay/info   ← returns live config (facilitator, price, network)
  ```

  **Live config (as of July 2026):**
  - Facilitator: CDP (`https://api.cdp.coinbase.com/platform/v2/x402`)
  - Network: Base Mainnet (eip155:8453)
  - Price: $0.001 USDC per relay call

  ### Request body

  ```json
  {
    "token":       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "from":        "0xAGENT_ADDRESS",
    "to":          "0xRECIPIENT",
    "value":       "1000000",
    "validAfter":  "1750000000",
    "validBefore": "1750003600",
    "nonce":       "0xRANDOM_32_BYTES",
    "v":           27,
    "r":           "0x...",
    "s":           "0x..."
  }
  ```

  ### Response

  ```json
  {
    "txHash":     "0x...",
    "action_ref": "uuid-..."
  }
  ```

  ---

  ## Authentication

  Two ways to authenticate with the relay:

  ### Option A — API Key (recommended for agents)

  Create a `bpk_` key in the [Developer Portal](/developer). Include it as the `X-API-Key` header to bypass the $0.001 x402 payment gate:

  ```http
  POST /api/v2/relay
  X-API-Key: bpk_your_key_here
  Content-Type: application/json
  ```

  API keys are:
  - Generated from an EIP-191 wallet signature (no password required)
  - Stored as SHA-256 hashes in the database (never in plaintext)
  - Scoped to your wallet address
  - Rotatable at any time from the Developer Portal

  ### Option B — x402 Micropayment

  Send a valid x402 payment header with each request. The relay will return a `402 Payment Required` response with payment details on the first call:

  ```
  HTTP/1.1 402 Payment Required
  X-Payment-Required: {"scheme":"exact","amount":"1000","token":"0x833589...","payTo":"0x..."}
  ```

  The agent then pays $0.001 USDC via the x402 protocol and retries. No API key required — fully autonomous.

  See [x402.org](https://www.x402.org) for the client spec.

  ---

  ## TypeScript Example (viem)

  ```typescript
  import { createWalletClient, http, parseUnits } from "viem";
  import { base } from "viem/chains";
  import { privateKeyToAccount } from "viem/accounts";

  const USDC    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const RELAY   = "https://basepay.replit.app/api/v2/relay";
  const API_KEY = process.env.BASEPAY_API_KEY; // bpk_...

  const account       = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
  const walletClient  = createWalletClient({ account, chain: base, transport: http() });
  const publicClient  = createPublicClient({ chain: base, transport: http() });

  const validAfter  = BigInt(Math.floor(Date.now() / 1000) - 10);
  const validBefore = validAfter + 3600n;
  const nonce       = `0x${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}`;

  // 1. Sign EIP-3009 authorization (off-chain — zero gas, zero ETH)
  const sig = await walletClient.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from",        type: "address" },
        { name: "to",          type: "address" },
        { name: "value",       type: "uint256" },
        { name: "validAfter",  type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce",       type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from:        account.address,
      to:          "0xRECIPIENT",
      value:       parseUnits("1.00", 6),  // 1.00 USDC
      validAfter,
      validBefore,
      nonce,
    },
  });

  // 2. POST to relay (API key bypasses $0.001 x402 gate)
  const res = await fetch(RELAY, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({
      token:       USDC,
      from:        account.address,
      to:          "0xRECIPIENT",
      value:       parseUnits("1.00", 6).toString(),
      validAfter:  validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      v: parseInt(sig.slice(130, 132), 16),
      r: `0x${sig.slice(2, 66)}`,
      s: `0x${sig.slice(66, 130)}`,
    }),
  });

  const { txHash, action_ref } = await res.json();
  console.log("Sent gasless USDC:", txHash, "ref:", action_ref);
  ```

  ---

  ## Python Example (web3.py / eth-account)

  ```python
  import os, time, secrets, httpx
  from eth_account import Account
  from eth_account.messages import encode_typed_data

  USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  RELAY = "https://basepay.replit.app/api/v2/relay"

  account  = Account.from_key(os.environ["AGENT_PRIVATE_KEY"])
  api_key  = os.environ["BASEPAY_API_KEY"]  # bpk_...

  now          = int(time.time())
  valid_after  = now - 10
  valid_before = now + 3600
  nonce        = "0x" + secrets.token_hex(32)
  amount       = 1_000_000  # 1.00 USDC (6 decimals)

  signed = Account.sign_typed_data(
      account.key,
      domain_data={
          "name": "USD Coin", "version": "2",
          "chainId": 8453, "verifyingContract": USDC,
      },
      message_types={
          "TransferWithAuthorization": [
              {"name": "from",        "type": "address"},
              {"name": "to",          "type": "address"},
              {"name": "value",       "type": "uint256"},
              {"name": "validAfter",  "type": "uint256"},
              {"name": "validBefore", "type": "uint256"},
              {"name": "nonce",       "type": "bytes32"},
          ]
      },
      message={
          "from":        account.address,
          "to":          "0xRECIPIENT",
          "value":       amount,
          "validAfter":  valid_after,
          "validBefore": valid_before,
          "nonce":       nonce,
      },
  )

  r = httpx.post(RELAY, headers={"X-API-Key": api_key}, json={
      "token": USDC, "from": account.address, "to": "0xRECIPIENT",
      "value": str(amount),
      "validAfter": str(valid_after), "validBefore": str(valid_before), "nonce": nonce,
      "v": signed.v, "r": signed.r.hex(), "s": signed.s.hex(),
  })
  print("txHash:", r.json()["txHash"])
  ```

  ---

  ## Base MCP — Give Your Agent a Wallet

  The [Base MCP](https://docs.base.org/ai-agents/quickstart) (Model Context Protocol) server exposes wallet tools directly to AI agents running in Claude, GPT-4, or any MCP-compatible runtime. Combine it with BasePay's x402 relay for fully autonomous USDC payment flows.

  ```json
  {
    "mcpServers": {
      "base": {
        "command": "npx",
        "args": ["-y", "@base/mcp-legacy"],
        "env": { "WALLET_PRIVATE_KEY": "0x..." }
      }
    }
  }
  ```

  The agent can then call BasePay's relay endpoint from any MCP-compatible tool call, creating autonomous payment pipelines without any human approval.

  ---

  ## Server Implementation

  The relay server (`artifacts/api-server/src/routes/x402relay.ts`) is gated by the x402 middleware:

  - Uses `@x402/express` middleware — returns `402 Payment Required` when no valid payment header is present
  - Falls back to API key auth (`X-API-Key`) — keys are verified against SHA-256 hashes in the DB
  - Facilitator: CDP (`https://api.cdp.coinbase.com/platform/v2/x402`) on Base Mainnet
  - Payment goes to `FEE_COLLECTOR_ADDRESS` env var

  ---

  ## References

  - [x402 Protocol Specification](https://x402.org)
  - [coinbase/x402 GitHub](https://github.com/coinbase/x402)
  - [Base AI Agent Quickstart](https://docs.base.org/ai-agents/quickstart)
  - [Base MCP Server](https://github.com/base/base-mcp-legacy)
  - [EIP-3009 Specification](https://eips.ethereum.org/EIPS/eip-3009)
  